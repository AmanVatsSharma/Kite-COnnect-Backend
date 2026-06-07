/**
 * Market Data Gateway (Socket.IO)
 *
 * Handles Socket.IO-based WebSocket connections for real-time market data streaming.
 *
 * Features:
 * - Socket.IO protocol support with automatic fallback to polling
 * - Redis adapter for multi-instance scalability
 * - API key authentication and connection limit enforcement
 * - Mode-aware subscriptions (LTP, OHLCV, Full)
 * - Intelligent batching and deduplication
 *
 * Endpoint: /market-data
 * Protocol: Socket.IO over WebSocket Secure (WSS)
 * Authentication: Query parameter (?api_key=...) or header (x-api-key)
 * @updated 2026-05-04 — Per-key provider locking: lockedProvider gates cross-provider prefixes only; removed stream-level forcedProvider pin so kite dual-subscribe (fallback) remains active.
 *
 * @class MarketDataGateway
 * @implements OnGatewayConnection, OnGatewayDisconnect
 */

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, OnModuleInit } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import { MarketDataProviderResolverService } from '@features/market-data/application/market-data-provider-resolver.service';
import { ApiKeyService } from '@features/auth/application/api-key.service';
import { MarketDataStreamService } from '@features/market-data/application/market-data-stream.service';
import { Inject, forwardRef } from '@nestjs/common';
import {
  validateSubscribePayload,
  validateUnsubscribePayload,
  validateSetModePayload,
} from '@shared/utils/ws-validation';
import { OriginAuditService } from '@features/admin/application/origin-audit.service';
import { MetricsService } from '@infra/observability/metrics.service';
import { AbuseDetectionService } from '@features/auth/application/abuse-detection.service';
import {
  shapeMarketTickForMode,
  StreamTickMode,
  MarketTickEmitOptions,
} from '@features/market-data/application/tick-shape.util';
import { MarketDataWsInterestService } from '@features/market-data/application/market-data-ws-interest.service';
import {
  internalToClientProviderName,
  InternalProviderName,
  normalizeProviderAlias,
} from '@shared/utils/provider-label.util';
import {
  MarketDataGatewaySubscriptionRegistry,
  MarketDataClientSubscription,
} from '@features/market-data/interface/market-data-gateway-subscription.registry';
import { InstrumentRegistryService } from '@features/market-data/application/instrument-registry.service';
import { parseProviderPrefix } from '@shared/utils/ws-provider-prefix.util';

const PROTOCOL_VERSION = '2.0';

@WebSocketGateway({
  cors: {
    origin: '*', // Allow all origins for SaaS (can be restricted via CORS_ORIGIN env var)
  },
  namespace: '/market-data', // Socket.IO namespace
})
export class MarketDataGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MarketDataGateway.name);
  private statusSubscribed = false;

  // In-memory bytes accumulator per API key — flushed to Redis every 10 seconds
  private readonly bytesAccumulator = new Map<string, number>();
  private bytesFlushTimer?: ReturnType<typeof setInterval>;
  /** Consecutive failure count per key for bytes flush retry. Resets on success. */
  private readonly bytesFlushRetryCount = new Map<string, number>();
  private static readonly BYTES_FLUSH_MAX_RETRIES = 3;

  // Per-key tick throttle cache (ms). Loaded from API key record on connect/update.
  private readonly apiKeyThrottleMs = new Map<string, number>();
  // Per-socket per-instrument last-sent timestamp for per-key throttle enforcement.
  private readonly perSocketLastSent = new Map<string, Map<number, number>>();

  // In-memory room membership — maps room name → socket IDs.
  // Used in broadcastMarketData instead of Socket.IO's fetchSockets() (O(n) per room per tick).
  private readonly roomMembers = new Map<string, Set<string>>();

  constructor(
    private redisService: RedisService,
    private providerResolver: MarketDataProviderResolverService,
    private apiKeyService: ApiKeyService,
    @Inject(forwardRef(() => MarketDataStreamService))
    private streamService: MarketDataStreamService,
    private originAudit: OriginAuditService,
    private metrics: MetricsService,
    private abuseDetection: AbuseDetectionService,
    private readonly wsInterest: MarketDataWsInterestService,
    private readonly subscriptionRegistry: MarketDataGatewaySubscriptionRegistry,
    private readonly instrumentRegistry: InstrumentRegistryService,
  ) {}

  // ---------------------------------------------------------------------------
  // In-memory room membership helpers (used by broadcastMarketData hot path)
  // ---------------------------------------------------------------------------
  private addToRoom(room: string, socketId: string): void {
    let members = this.roomMembers.get(room);
    if (!members) {
      members = new Set<string>();
      this.roomMembers.set(room, members);
    }
    members.add(socketId);
  }

  private removeFromRoom(room: string, socketId: string): void {
    this.roomMembers.get(room)?.delete(socketId);
  }

  async onModuleInit() {
    // Flush bytes accumulator to Redis every 10s (low-overhead, batched)
    this.bytesFlushTimer = setInterval(() => {
      void this.flushBytesAccumulator();
    }, 10_000);

    // Subscribe to API key updates to enforce limits instantly across all instances
    try {
      await this.redisService.subscribe('api_key_updates', async (message) => {
        try {
          if (message && message.key) {
            await this.handleApiKeyUpdate(message.key);
          }
        } catch (e) {
          this.logger.error('Error handling api_key_updates message', e);
        }
      });
      this.logger.log('Subscribed to api_key_updates channel');
    } catch (e) {
      this.logger.error('Failed to subscribe to api_key_updates', e);
    }
  }

  /**
   * Handle API key configuration updates (e.g. changed entitlements).
   * - Refreshes the cached API key record for connected clients.
   * - Re-evaluates active subscriptions against new allowed exchanges.
   * - Instantly unsubscribes from forbidden instruments.
   */
  private async handleApiKeyUpdate(key: string) {
    const affectedClients = Array.from(
      this.subscriptionRegistry.values(),
    ).filter((sub) => sub.apiKey === key);

    if (affectedClients.length === 0) return;

    this.logger.log(
      `Processing API key update for ${key} (${affectedClients.length} active clients)`,
    );

    // Fetch the latest API key record
    const newRecord = await this.apiKeyService.validateApiKey(key);
    if (!newRecord) {
      // Key might have been deactivated or deleted
      this.logger.warn(`API key ${key} no longer valid, disconnecting clients`);
      for (const sub of affectedClients) {
        const socket = this.server.sockets.sockets.get(sub.socketId);
        if (socket) {
          socket.emit('error', {
            code: 'api_key_invalid',
            message: 'API key is no longer valid',
          });
          socket.disconnect(true);
        }
      }
      return;
    }

    // Refresh per-key tick throttle from updated record
    const updatedThrottle = (newRecord as any)?.live_tick_throttle_ms ?? 0;
    if (updatedThrottle > 0) {
      this.apiKeyThrottleMs.set(key, updatedThrottle);
    } else {
      this.apiKeyThrottleMs.delete(key);
    }

    // Update cached record and re-evaluate entitlements
    const allowedExchanges = new Set(
      (Array.isArray(newRecord.metadata?.exchanges) &&
        newRecord.metadata?.exchanges) || [
        'NSE_EQ',
        'NSE_FO',
        'NSE_CUR',
        'MCX_FO',
      ],
    );

    for (const sub of affectedClients) {
      const socket = this.server.sockets.sockets.get(sub.socketId);
      if (!socket) continue;

      // Update cached record
      (socket.data as any).apiKeyRecord = newRecord;

      // Re-evaluate subscriptions
      // We need to map current tokens back to exchanges to check permissions
      const tokensToCheck = [...sub.instruments];
      if (tokensToCheck.length === 0) continue;

      // Resolve tokens to exchanges (best effort)
      const tokenExchangeMap = new Map<number, string>();
      try {
        const provider = await this.providerResolver.resolveForWebsocket();
        const exMap: Map<string, any> = (provider as any)?.resolveExchanges
          ? await (provider as any).resolveExchanges(
              tokensToCheck.map((t) => String(t)),
            )
          : new Map();
        for (const [tokStr, ex] of exMap.entries()) {
          tokenExchangeMap.set(Number(tokStr), String(ex));
        }
      } catch (e) {
        this.logger.warn('Failed to resolve exchanges during update check', e);
      }

      const forbiddenTokens: number[] = [];
      const keptTokens: number[] = [];

      for (const token of tokensToCheck) {
        const ex = tokenExchangeMap.get(token);
        // If we can't resolve exchange, we assume it's allowed (fail-open) OR
        // we could check if we have explicit pair info stored.
        // For now, we rely on the resolver. If resolved and not in set -> forbidden.
        if (ex && !allowedExchanges.has(ex)) {
          forbiddenTokens.push(token);
        } else {
          keptTokens.push(token);
        }
      }

      if (forbiddenTokens.length > 0) {
        this.logger.log(
          `Revoking ${forbiddenTokens.length} subscriptions for client ${sub.socketId} due to entitlement change`,
        );
        // Unsubscribe from forbidden tokens
        await this.unsubscribeFromInstruments(forbiddenTokens, sub.socketId);
        forbiddenTokens.forEach((t) => {
          socket.leave(`instrument:${t}`);
          this.removeFromRoom(`instrument:${t}`, sub.socketId);
          this.wsInterest.removeInterest(t);
        });

        // Update local state
        sub.instruments = keptTokens;
        forbiddenTokens.forEach((t) => sub.modeByInstrument.delete(t));

        // Notify client
        socket.emit('error', {
          code: 'entitlement_revoked',
          message:
            'Some subscriptions were revoked due to updated API key permissions',
          revoked_tokens: forbiddenTokens,
        });

        // Send updated subscription list
        socket.emit('unsubscription_confirmed', {
          requested: forbiddenTokens,
          removed: forbiddenTokens,
          remaining: keptTokens,
          reason: 'entitlement_update',
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Handle new client connection
   * - Validates API key (from query param or header)
   * - Enforces connection limits per API key
   * - Attaches Redis adapter for scaling (lazy initialization)
   * - Initializes client subscription tracking
   * - Sends connection confirmation event
   *
   * @param client - Socket.IO client instance
   * @throws Disconnects client on invalid API key or limit exceeded
   */
  async handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);

    // API key validation and connection limit enforcement
    try {
      const headerKey = (client.handshake.headers['x-api-key'] as string) || '';
      const queryKey = (client.handshake.query['api_key'] as string) || '';
      const apiKey = headerKey || queryKey;
      if (!apiKey) {
        client.emit('error', {
          code: 'missing_api_key',
          message: 'Missing x-api-key',
        });
        client.disconnect(true);
        return;
      }
      const record = await this.apiKeyService.validateApiKey(apiKey);
      if (!record) {
        client.emit('error', {
          code: 'invalid_api_key',
          message: 'Invalid API key',
        });
        client.disconnect(true);
        return;
      }

      // Strict abuse / resell enforcement for WS: block keys marked as abusive.
      try {
        const status = await this.abuseDetection.getStatusForApiKey(apiKey);
        if (status?.blocked) {
          this.logger.warn(
            `Blocked API key used on WS connect; key=${apiKey} risk_score=${status.risk_score}`,
          );
          client.emit('error', {
            code: 'key_blocked_for_abuse',
            message:
              'This API key has been blocked due to suspected reselling or abusive usage. Contact support for review.',
            risk_score: status.risk_score,
            reasons: status.reason_codes,
          });
          this.logger.warn(
            `[MarketDataGateway] Blocked API key WS connect rejected apiKey=${apiKey} tenant=${(record as any)?.tenant_id} risk=${status.risk_score}`,
          );
          client.disconnect(true);
          return;
        }
      } catch (e) {
        this.logger.warn(
          `Abuse detection check failed for WS key=${apiKey}; continuing`,
          e as any,
        );
        this.logger.warn(
          `[MarketDataGateway] Abuse detection check failed — continuing apiKey=${apiKey} err=${(e as any)?.message ?? e}`,
        );
      }
      await this.apiKeyService.trackWsConnection(
        apiKey,
        record.connection_limit,
      );
      (client.data as any).apiKey = apiKey;
      (client.data as any).apiKeyRecord = record;
      (client.data as any).connectedAt = new Date().toISOString();

      // Cache per-key throttle from record (null means inherit global — treat as 0 here)
      const keyThrottle = (record as any)?.live_tick_throttle_ms ?? 0;
      if (keyThrottle > 0) this.apiKeyThrottleMs.set(apiKey, keyThrottle);
      this.perSocketLastSent.set(client.id, new Map());

      // Best-effort origin audit for WS connection
      try {
        const { ip, userAgent, origin } = this.extractWsOriginContext(client);
        this.originAudit
          .recordWsEvent({
            apiKey,
            apiKeyId: (record as any)?.id ?? null,
            tenantId: (record as any)?.tenant_id ?? null,
            event: 'connect',
            status: 101,
            ip,
            userAgent,
            origin,
            durationMs: null,
            country: null,
            asn: null,
            meta: {
              socketId: client.id,
              namespace: client.nsp?.name,
            },
          })
          .catch(() => {
            // Swallow errors; they are logged inside the service.
          });

        // Metrics: track active WS connections per API key
        try {
          this.metrics.wsConnectionsByApiKey.labels(apiKey).inc();
        } catch {
          // Metrics must never impact connection handling
        }
      } catch (e) {
        this.logger.warn('WS origin audit (connect) failed', e as any);
      }
    } catch (err) {
      this.logger.warn(
        `Connection rejected for ${client.id}: ${err?.message || err}`,
      );
      client.disconnect(true);
      return;
    }

    // Initialize client subscription with connection limits per API key (if provided)
    this.subscriptionRegistry.set(client.id, {
      socketId: client.id,
      userId: (client.handshake.query.userId as string) || 'anonymous',
      instruments: [],
      subscriptionType: 'live',
      modeByInstrument: new Map(),
      apiKey: (client.data as any)?.apiKey,
    });

    // Send connection confirmation
    client.emit('connected', {
      message: 'Connected to market data stream',
      clientId: client.id,
      timestamp: new Date().toISOString(),
    });

    // Subscribe once to stream status events and broadcast to all clients
    try {
      if (!this.statusSubscribed) {
        await this.redisService.subscribe('stream:status', (message) => {
          try {
            this.server.emit('stream_status', message);
          } catch (e) {
            this.logger.warn('Failed broadcasting stream_status', e as any);
          }
        });
        this.statusSubscribed = true;
        this.logger.log('Subscribed to stream:status channel');
      }
      // Emit current status snapshot to the just-connected client
      const snapshot = await this.streamService.getStreamingStatus();
      client.emit('stream_status', {
        event: snapshot.isStreaming ? 'connected' : 'disconnected',
        snapshot,
        ts: Date.now(),
      });
    } catch (e) {
      this.logger.warn(
        'Failed initializing stream status subscription',
        e as any,
      );
    }

    // Emit a branded welcome + onboarding payload for client UX
    try {
      const apiKey: string = (client.data as any)?.apiKey;
      const record: any = (client.data as any)?.apiKeyRecord;
      const limits: Record<string, any> = {
        connection: record?.connection_limit || 3,
        maxUpstreamInstruments: Number(
          process.env.KITE_TICKER_INSTRUMENT_LIMIT ?? 3000,
        ),
        maxSubscriptionsPerSocket:
          record?.ws_max_instruments ??
          Number(process.env.WS_MAX_INSTRUMENTS ?? 3000),
      };
      try {
        const provider = await this.providerResolver.resolveForWebsocket();
        const lim = (provider as any)?.getSubscriptionLimit?.();
        if (Number.isFinite(lim) && lim > 0) {
          limits.maxUpstreamInstruments = lim;
        }
        const v = (provider as any)?.getVortexWsLimits?.() ?? null;
        if (v) {
          limits.maxSubscriptionsPerSocket =
            record?.ws_max_instruments ?? v.perSocket;
          limits.maxVortexShards = v.maxShards;
          limits.maxVortexInstruments = v.total;
        }
      } catch {}
      const exchanges = (Array.isArray(record?.metadata?.exchanges) &&
        record?.metadata?.exchanges) || [
        'NSE_EQ',
        'NSE_FO',
        'NSE_CUR',
        'MCX_FO',
      ];
      const usage = await this.apiKeyService.getUsageReport(apiKey);
      const lockedKeyProv = normalizeProviderAlias(
        (record as any)?.provider ?? null,
      );
      const internal =
        lockedKeyProv ??
        (await this.providerResolver.getResolvedInternalProviderNameForWebsocket());
      const clientProvider = internalToClientProviderName(internal);
      const instructions = {
        subscribe:
          "socket.emit('subscribe', { instruments: [26000, 'NSE_FO-135938'], mode: 'ltp' })",
      };
      client.emit('welcome', {
        protocol_version: PROTOCOL_VERSION,
        message: 'Welcome to Vedpragya MarketData Solutions',
        provider: clientProvider,
        exchanges,
        limits,
        instructions,
        apiKey: {
          tenant: (client.data as any)?.apiKeyRecord?.tenant_id || 'unknown',
          currentWsConnections: usage?.currentWsConnections || 0,
          httpRequestsThisMinute: usage?.httpRequestsThisMinute || 0,
          note: `Your API key is enabled for ${clientProvider} provider. Exchanges reflect entitlements.`,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      this.logger.warn('Failed to emit welcome payload', e as any);
    }
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    const subscription = this.subscriptionRegistry.get(client.id);
    if (subscription) {
      // Unsubscribe from instruments if any
      if (subscription.instruments.length > 0) {
        for (const t of subscription.instruments) {
          this.wsInterest.removeInterest(t);
        }
        await this.unsubscribeFromInstruments(subscription.instruments);
      }

      this.subscriptionRegistry.delete(client.id);
    }

    // Free per-socket throttle state
    this.perSocketLastSent.delete(client.id);

    // Untrack WS connection for API key
    try {
      const apiKey = (client.data as any)?.apiKey;
      if (apiKey) {
        await this.apiKeyService.untrackWsConnection(apiKey);
        try {
          this.metrics.wsConnectionsByApiKey.labels(apiKey).dec();
        } catch {
          // Ignore metrics failures
        }
      }
    } catch (e) {
      this.logger.warn(`Failed to untrack ws connection for ${client.id}`);
    }

    // Best-effort origin audit for WS disconnect
    try {
      const record: any = (client.data as any)?.apiKeyRecord;
      const apiKey: string = (client.data as any)?.apiKey;
      const { ip, userAgent, origin } = this.extractWsOriginContext(client);
      this.originAudit
        .recordWsEvent({
          apiKey: apiKey || null,
          apiKeyId: (record as any)?.id ?? null,
          tenantId: (record as any)?.tenant_id ?? null,
          event: 'disconnect',
          status: 499,
          ip,
          userAgent,
          origin,
          durationMs: null,
          country: null,
          asn: null,
          meta: {
            socketId: client.id,
            namespace: client.nsp?.name,
          },
        })
        .catch(() => {
          // Errors already logged inside the service.
        });
    } catch (e) {
      this.logger.warn('WS origin audit (disconnect) failed', e as any);
    }

    // Clean up room membership map — remove this socket from any rooms it was in
    // ( Socket.IO tracks rooms on the socket object internally )
    const rooms: string[] = (client as any).rooms
      ? [...(client as any).rooms]
      : [];
    for (const room of rooms) {
      if (room && room.startsWith('instrument:')) {
        this.removeFromRoom(room, client.id);
      }
    }
  }

  /**
   * Subscribe to market data for instruments
   *
   * Event: 'subscribe' (standard) or 'subscribe_instruments' (deprecated)
   *
   * @param data.instruments - Array of instrument tokens to subscribe to
   * @param data.mode - Data mode: 'ltp', 'ohlcv', or 'full' (default: 'ltp')
   * @param data.type - Subscription type: 'live', 'historical', or 'both' (default: 'live')
   *
   * Events emitted:
   * - subscription_confirmed: When subscription succeeds
   * - error: When subscription fails
   *
   * @example
   * socket.emit('subscribe', { instruments: [26000], mode: 'ltp' });
   */
  @SubscribeMessage('subscribe')
  async handleSubscribe(
    @MessageBody()
    data: {
      instruments?: number[];
      symbols?: string[];
      type?: 'live' | 'historical' | 'both';
      mode?: 'ltp' | 'ohlcv' | 'full';
    },
    @ConnectedSocket() client: Socket,
  ) {
    return this.doSubscribe(data, client);
  }

  // Deprecated event name - kept for backward compatibility
  @SubscribeMessage('subscribe_instruments')
  async handleSubscribeInstruments(
    @MessageBody()
    data: {
      instruments: number[];
      type?: 'live' | 'historical' | 'both';
      mode?: 'ltp' | 'ohlcv' | 'full';
    },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.warn(
      `Client ${client.id} used deprecated event 'subscribe_instruments'. Please use 'subscribe' instead.`,
    );
    return this.doSubscribe(data, client);
  }

  // Internal handler
  private async doSubscribe(
    data: {
      instruments?: number[];
      symbols?: string[];
      type?: 'live' | 'historical' | 'both';
      mode?: 'ltp' | 'ohlcv' | 'full';
    },
    client: Socket,
  ) {
    try {
      // Readiness gate: wait for the instrument-registry background warm-up to complete
      // before any resolve* call. The warm-up runs off the boot path (resolves 502 Bad
      // Gateway) but the in-memory maps are empty until it finishes. A subscribe that
      // hits the empty maps returns `not_found` for every symbol, which the user reports
      // as "unresolved". After the first call post-warm-up, this awaits a settled promise
      // (one microtask) — no measurable cost.
      await this.instrumentRegistry.ready();

      const { type = 'live', mode = 'ltp' } = data;
      let instruments = data.instruments || [];
      let symbols = data.symbols;

      // Resolve symbols to provider tokens if provided.
      // Accepts both canonical format ("NSE:RELIANCE") and plain underlying names ("RELIANCE").
      const resolvedSymbols: Array<{
        symbol: string;
        uirId: number;
        providerToken?: number;
        resolvedAs?: string;
      }> = [];
      const unresolvedSymbols: string[] = [];
      const derivativeResolved: Array<{
        symbol: string;
        uirId: number;
        resolvedAs: string;
        expiry: string | null;
        type: string;
      }> = [];
      // UIR IDs for instruments whose provider is not the global WS provider (e.g. massive US stocks).
      // These bypass exchange-pair resolution and are routed directly by the streaming batch processor.
      const directUirIds: number[] = [];

      // ── Provider-prefix syntax (Falcon:reliance, Vayu:26000, Massive:AAPL, Binance:BTCUSDT) ──
      // Walk both `instruments` and `symbols` extracting prefixed items. Each pinned UIR is
      // routed to its requested provider and bypasses kite↔vortex dual-subscribe.
      const forcedByProvider = new Map<
        InternalProviderName,
        Array<{ uirId: number; canonical: string; raw: string }>
      >();
      const forcedConfirm: Array<{
        symbol: string;
        uirId: number;
        provider: string;
        canonical: string;
      }> = [];
      const enabledProviders = new Set(
        this.providerResolver.getEnabledProviders(),
      );
      const lockedProvider: InternalProviderName | null =
        normalizeProviderAlias(
          (client.data as any).apiKeyRecord?.provider ?? null,
        );

      // Provider for pair resolution (fallback to global or locked)
      const providerForPair =
        lockedProvider ?? this.streamService.activeProviderName;

      const consumePrefixed = (items: Array<unknown>): unknown[] => {
        const remaining: unknown[] = [];
        for (const item of items) {
          const prefixed = parseProviderPrefix(item);
          if (!prefixed) {
            remaining.push(item);
            continue;
          }
          if (lockedProvider && prefixed.provider !== lockedProvider) {
            client.emit('error', {
              code: 'provider_locked',
              symbol: prefixed.raw,
              provider: internalToClientProviderName(prefixed.provider),
              lockedProvider: internalToClientProviderName(lockedProvider),
              message: `${internalToClientProviderName(prefixed.provider)} provider is blocked for this key; your key is locked to ${internalToClientProviderName(lockedProvider)}`,
            });
            continue;
          }
          if (!enabledProviders.has(prefixed.provider)) {
            client.emit('error', {
              code: 'forced_provider_unavailable',
              symbol: prefixed.raw,
              provider: internalToClientProviderName(prefixed.provider),
              message: `Requested provider ${internalToClientProviderName(prefixed.provider)} has no active upstream connection`,
            });
            continue;
          }
          const result = this.instrumentRegistry.resolveProviderScopedSymbol(
            prefixed.provider,
            prefixed.identifier,
          );
          if (result.status === 'not_found') {
            unresolvedSymbols.push(
              `${prefixed.raw} (not found in ${internalToClientProviderName(prefixed.provider)} catalog)`,
            );
            continue;
          }
          if (result.status === 'ambiguous') {
            unresolvedSymbols.push(
              `${prefixed.raw} (ambiguous in ${internalToClientProviderName(prefixed.provider)} — try: ${result.candidates.join(', ')})`,
            );
            continue;
          }
          if (!forcedByProvider.has(prefixed.provider))
            forcedByProvider.set(prefixed.provider, []);
          forcedByProvider.get(prefixed.provider)!.push({
            uirId: result.uirId,
            canonical: result.canonical,
            raw: prefixed.raw,
          });
          forcedConfirm.push({
            symbol: prefixed.raw,
            uirId: result.uirId,
            provider: internalToClientProviderName(prefixed.provider),
            canonical: result.canonical,
          });
        }
        return remaining;
      };

      // Track string items in `instruments` that the explicit-pair / numeric parser
      // at line ~990 must skip because they have been routed through a flex or
      // derivative resolution path above. The Set is keyed by the original (raw) string
      // and by the trimmed uppercase form so we can match in either case.
      const consumedStringSet = new Set<string>();

      if (Array.isArray(instruments) && instruments.length > 0) {
        instruments = consumePrefixed(instruments) as any;
      }
      if (Array.isArray(symbols) && symbols.length > 0) {
        symbols = consumePrefixed(symbols) as any;
      }

      // ── Fallback normalization pass for non-prefixed strings left in `instruments` ──
      // Some clients send strings like "MCX:GOLD:FUT" or "RELIANCE" inside the
      // `instruments` array instead of `symbols`. The provider-prefix path above only
      // catches the `Provider:identifier` syntax; everything else falls through.
      // We resolve the leftover string items here so the explicit-pair / numeric parser
      // downstream does not silently drop them.
      if (Array.isArray(instruments) && instruments.length > 0) {
        const leftover: unknown[] = [];
        for (const item of instruments as unknown[]) {
          if (typeof item !== 'string') {
            leftover.push(item);
            continue;
          }
          const trimmed = item.trim();
          if (trimmed.length === 0) {
            leftover.push(item);
            continue;
          }

          // Derivative shape: `<EXCHANGE>:<UNDERLYING>:(FUT|CE|PE)` — case-insensitive.
          if (/^[^:]+:[^:]+:(FUT|CE|PE)$/i.test(trimmed)) {
            const result = this.instrumentRegistry.resolveDerivativeSymbol(trimmed);
            if (result.status === 'resolved') {
              directUirIds.push(result.uirId);
              derivativeResolved.push({
                symbol: trimmed,
                uirId: result.uirId,
                resolvedAs: result.canonical ?? trimmed,
                expiry: result.expiry
                  ? result.expiry.toISOString().split('T')[0]
                  : null,
                type: result.instrument_type ?? 'FUT',
              });
              resolvedSymbols.push({
                symbol: trimmed,
                uirId: result.uirId,
                resolvedAs:
                  result.canonical && result.canonical !== trimmed
                    ? result.canonical
                    : undefined,
              });
            } else if (result.status === 'ambiguous') {
              unresolvedSymbols.push(
                `${trimmed} (ambiguous — try: ${result.candidates?.join(', ')})`,
              );
            } else {
              unresolvedSymbols.push(
                `${trimmed} (${result.reason ?? 'not found'})`,
              );
            }
            consumedStringSet.add(trimmed);
            consumedStringSet.add(trimmed.toUpperCase());
            // Do NOT push the raw string into `leftover` — the downstream parser
            // would only re-fail it and waste a cycle. The resolution above is
            // the terminal step for this item.
            continue;
          }

          // Plain underlying / canonical shape (non-derivative) — try flex resolution.
          // This is the same path used by `symbols` for plain names. It bypasses the
          // kite↔vortex dual-subscribe path and lands in `directUirIds` when the global
          // provider has no token (e.g. massive US stocks).
          if (/^[^:]+(?::[^:]+)?$/.test(trimmed)) {
            const flexResult = this.instrumentRegistry.resolveFlexSymbol(trimmed);
            if (flexResult.status === 'resolved') {
              const providerName =
                lockedProvider ?? this.streamService.activeProviderName;
              const providerToken = this.instrumentRegistry.getProviderToken(
                flexResult.uirId,
                providerName,
              );
              if (providerToken != null) {
                const numToken = Number(providerToken);
                if (Number.isFinite(numToken)) {
                  leftover.push(numToken);
                  resolvedSymbols.push({
                    symbol: trimmed,
                    uirId: flexResult.uirId,
                    providerToken: numToken,
                    resolvedAs:
                      flexResult.canonical &&
                      flexResult.canonical !== trimmed
                        ? flexResult.canonical
                        : undefined,
                  });
                } else {
                  directUirIds.push(flexResult.uirId);
                  resolvedSymbols.push({
                    symbol: trimmed,
                    uirId: flexResult.uirId,
                    resolvedAs:
                      flexResult.canonical &&
                      flexResult.canonical !== trimmed
                        ? flexResult.canonical
                        : undefined,
                  });
                }
              } else {
                // No token for the global provider — route via directUirIds the same
                // way the `symbols` branch does (kite↔vortex dual-subscribe bypass).
                const bestProv = this.instrumentRegistry.getBestProviderForUirId(
                  flexResult.uirId,
                );
                if (bestProv) {
                  directUirIds.push(flexResult.uirId);
                  resolvedSymbols.push({
                    symbol: trimmed,
                    uirId: flexResult.uirId,
                    resolvedAs:
                      flexResult.canonical &&
                      flexResult.canonical !== trimmed
                        ? flexResult.canonical
                        : undefined,
                  });
                } else {
                  unresolvedSymbols.push(trimmed);
                }
              }
            } else if (flexResult.status === 'ambiguous') {
              unresolvedSymbols.push(
                `${trimmed} (ambiguous — try: ${flexResult.candidates.join(', ')})`,
              );
            } else {
              unresolvedSymbols.push(trimmed);
            }
            consumedStringSet.add(trimmed);
            consumedStringSet.add(trimmed.toUpperCase());
            // Whether resolved or unresolved, the raw string is no longer a valid
            // token (already routed above, or already echoed as unresolved). The
            // downstream explicit-pair parser would only silently drop it, so we
            // mark it consumed and skip it.
            continue;
          }

          // Exchange-token pair shape: `<EXCHANGE>-<TOKEN>` (e.g. "NSE_EQ-12345")
          // TOKEN can be UIR ID or provider token. Try UIR ID first.
          const pairMatch = trimmed.match(/^([A-Z_]+)-(\d+)$/i);
          if (pairMatch) {
            const ex = pairMatch[1].toUpperCase();
            const tok = pairMatch[2];
            const numTok = Number(tok);
            if (Number.isFinite(numTok)) {
              let uirId: number | undefined;

              // 1. Try TOKEN as UIR ID (if canonical exists, it's valid)
              const canonical = this.instrumentRegistry.getCanonicalSymbol(numTok);
              this.logger.debug(
                `[PairMatch] input=${trimmed} ex=${ex} tok=${tok} numTok=${numTok} canonical=${canonical || 'null'}`,
              );
              if (canonical) {
                uirId = numTok;
              }

              // 2. Fall back to provider token lookup
              if (uirId == null) {
                uirId =
                  this.instrumentRegistry.resolveProviderToken('vortex', `${ex}-${tok}`) ??
                  this.instrumentRegistry.resolveProviderToken('vortex', tok) ??
                  this.instrumentRegistry.resolveProviderToken(
                    'vortex',
                    `${ex.toLowerCase()}-${tok}`,
                  );
              }
              if (uirId == null) {
                uirId = this.instrumentRegistry.resolveProviderToken(
                  'kite',
                  numTok,
                );
              }
              if (uirId == null) {
                uirId = this.instrumentRegistry.resolveProviderToken(
                  'massive',
                  tok,
                );
              }
              if (uirId == null) {
                uirId = this.instrumentRegistry.resolveProviderToken(
                  'binance',
                  tok,
                );
              }

              if (uirId != null) {
                const resolvedCanonical =
                  this.instrumentRegistry.getCanonicalSymbol(uirId) ??
                  trimmed;
                directUirIds.push(uirId);
                forcedConfirm.push({
                  symbol: trimmed,
                  uirId,
                  provider: internalToClientProviderName(providerForPair),
                  canonical: resolvedCanonical,
                });
                consumedStringSet.add(trimmed);
                consumedStringSet.add(trimmed.toUpperCase());
                continue;
              }
            }
          }

          // Unrecognized string shape — let the downstream parser have a look.
          leftover.push(item);
        }
        instruments = leftover as any;
      }

      if (Array.isArray(symbols) && symbols.length > 0) {
        const providerName =
          lockedProvider ?? this.streamService.activeProviderName;
        for (const sym of symbols) {
          const flexResult = this.instrumentRegistry.resolveFlexSymbol(sym);
          if (flexResult.status === 'not_found') {
            unresolvedSymbols.push(sym);
            continue;
          }
          if (flexResult.status === 'ambiguous') {
            unresolvedSymbols.push(
              `${sym} (ambiguous — try: ${flexResult.candidates.join(', ')})`,
            );
            continue;
          }
          const { uirId, canonical } = flexResult;
          const providerToken = this.instrumentRegistry.getProviderToken(
            uirId,
            providerName,
          );
          if (providerToken != null) {
            const numToken = Number(providerToken);
            if (Number.isFinite(numToken)) {
              instruments = [...instruments, numToken];
              resolvedSymbols.push({
                symbol: sym,
                uirId,
                providerToken: numToken,
                resolvedAs: canonical !== sym ? canonical : undefined,
              });
            }
          } else {
            // No token for the global provider — check if another provider owns this UIR.
            const bestProv =
              this.instrumentRegistry.getBestProviderForUirId(uirId);
            if (bestProv) {
              directUirIds.push(uirId);
              resolvedSymbols.push({
                symbol: sym,
                uirId,
                resolvedAs: canonical !== sym ? canonical : undefined,
              });
            } else {
              unresolvedSymbols.push(sym);
            }
          }
        }

        // ── Derivative symbol resolution (MCX:GOLD:FUT, NFO:NIFTY:CE, etc.) ──
        for (const sym of symbols) {
          const trimmed = String(sym).trim();
          // Check if this is a derivative symbol (has :FUT, :CE, :PE suffix)
          if (!/^[^:]+:[^:]+:(FUT|CE|PE)$/i.test(trimmed)) continue;

          const result = this.instrumentRegistry.resolveDerivativeSymbol(trimmed);
          if (result.status === 'not_found') {
            unresolvedSymbols.push(`${sym} (${result.reason ?? 'not found'})`);
            continue;
          }
          if (result.status === 'ambiguous') {
            unresolvedSymbols.push(
              `${sym} (ambiguous — try: ${result.candidates?.join(', ')})`,
            );
            continue;
          }
          // Resolved — get provider token and add to subscriptions
          const provName = lockedProvider ?? this.streamService.activeProviderName;
          const provToken = this.instrumentRegistry.getProviderToken(result.uirId, provName);
          if (provToken) {
            const numToken = Number(provToken);
            if (Number.isFinite(numToken)) {
              instruments = [...instruments, numToken];
            }
          }
          derivativeResolved.push({
            symbol: sym,
            uirId: result.uirId,
            resolvedAs: result.canonical ?? trimmed,
            expiry: result.expiry ? result.expiry.toISOString().split('T')[0] : null,
            type: result.instrument_type ?? 'FUT',
          });
          resolvedSymbols.push({
            symbol: sym,
            uirId: result.uirId,
            providerToken: provToken ? Number(provToken) : undefined,
            resolvedAs: result.canonical !== sym ? result.canonical : undefined,
          });
        }
      }

      const forcedTotal = Array.from(forcedByProvider.values()).reduce(
        (n, arr) => n + arr.length,
        0,
      );

      // Validate payload shape (instruments may now include symbol-resolved tokens)
      const v = validateSubscribePayload({ instruments, mode });
      if (
        !v.ok &&
        (!instruments || instruments.length === 0) &&
        directUirIds.length === 0 &&
        forcedTotal === 0
      ) {
        client.emit('error', {
          code: 'invalid_payload',
          message: 'Invalid subscribe payload — provide instruments or symbols',
          errors: v.errors,
          unresolvedSymbols,
        });
        return;
      }

      // Rate limit per event (per API key, with optional per-key overrides)
      try {
        const record: any = (client.data as any)?.apiKeyRecord;
        const apiKey: string =
          ((client.data as any)?.apiKey as string) || client.id;
        const globalLimit = Number(process.env.WS_SUBSCRIBE_RPS || 10);
        const perKeyLimit = Number(record?.ws_subscribe_rps);
        const limit =
          Number.isFinite(perKeyLimit) && perKeyLimit > 0
            ? perKeyLimit
            : globalLimit;
        const rl = await this.apiKeyService.checkWsRateLimit(
          apiKey,
          'subscribe',
          limit,
        );
        if (rl) {
          client.emit('error', {
            code: 'rate_limited',
            message: 'Subscribe rate limit exceeded for this API key',
            limit,
            retry_after_ms: rl.retry_after_ms,
          });
          this.logger.warn(
            `[MarketDataGateway] Subscribe rate limit exceeded apiKey=${apiKey} limit=${limit} retry_after_ms=${rl.retry_after_ms}`,
          );
          return;
        }
      } catch {}

      // Enforce admin WS blocklist (Redis-backed)
      try {
        const apiKey: string =
          ((client.data as any)?.apiKey as string) || client.id;
        const [keyBlocked, rawBlockedExchanges] = await Promise.all([
          this.redisService.get(`ws:block:apikey:${apiKey}`),
          this.redisService.get('ws:block:exchanges'),
        ]);
        if (keyBlocked) {
          client.emit('error', {
            code: 'api_key_blocked',
            message: 'This API key is blocked from WS subscriptions',
          });
          return;
        }
        if (rawBlockedExchanges) {
          (client as any).__blockedExchanges = new Set<string>(
            JSON.parse(rawBlockedExchanges as string),
          );
        }
      } catch {}

      // Allow subscriptions that consist solely of direct UIR IDs (massive US symbols)
      // or forced provider-prefixed UIR IDs (Falcon:|Vayu:|Massive:|Binance:).
      if (
        (!instruments ||
          !Array.isArray(instruments) ||
          instruments.length === 0) &&
        directUirIds.length === 0 &&
        forcedTotal === 0
      ) {
        client.emit('error', { message: 'Invalid instruments array' });
        return;
      }

      // Validate mode parameter
      if (!['ltp', 'ohlcv', 'full'].includes(mode)) {
        client.emit('error', {
          code: 'invalid_mode',
          message: 'Invalid mode. Must be ltp, ohlcv, or full',
        });
        return;
      }

      const subscription = this.subscriptionRegistry.get(client.id);
      if (!subscription) {
        client.emit('error', { message: 'Client subscription not found' });
        return;
      }

      // Ensure streaming is active; auto-start on first subscriber if needed.
      // Pure massive/direct-UIR subscriptions skip this check — their provider ticker
      // is lazy-init'd by the batch processor on first subscription. Forced provider-pinned
      // UIRs likewise skip auto-start; their ticker is lazy-init'd by the batch processor.
      const isPureDirectSubscription =
        instruments.length === 0 &&
        (directUirIds.length > 0 || forcedTotal > 0);
      if (!isPureDirectSubscription) {
        try {
          const status = await this.streamService.getStreamingStatus();
          if (!status?.isStreaming) {
            client.emit('stream_starting', {
              message: 'Streaming not active — auto-starting provider ticker…',
              ts: Date.now(),
            });
            const started = await this.streamService.autoStartIfNeeded();
            if (!started) {
              client.emit('error', {
                code: 'stream_unavailable',
                message:
                  'Could not auto-start streaming. Ensure provider credentials are configured (KITE_ACCESS_TOKEN / VORTEX_API_KEY) or ask admin to start the stream manually.',
              });
              return;
            }
          }
        } catch (e) {
          this.logger.warn(
            'Failed to read/auto-start streaming status',
            e as any,
          );
        }
      }

      // Parse instruments allowing both numeric tokens and EXCHANGE-TOKEN strings
      const requestedRaw = Array.from(new Set(instruments as any));
      const explicitPairs: Array<{ token: number; exchange: string }> = [];
      const numericTokens: number[] = [];

      for (const item of requestedRaw as any[]) {
        if (typeof item === 'string') {
          // Skip items already consumed by the flex/derivative normalization pass
          // above — they have either been routed to `directUirIds` or recorded as
          // unresolved, so the downstream explicit-pair parser must not re-touch
          // them (it would silently drop the original string anyway).
          const itemTrim = item.trim();
          if (
            consumedStringSet.has(itemTrim) ||
            consumedStringSet.has(itemTrim.toUpperCase())
          ) {
            continue;
          }
          const s = String(item).trim().toUpperCase();
          const m = s.match(/^([A-Z_]+)-(\d+)$/);
          if (m) {
            const ex = m[1] as any;
            const tok = Number(m[2]);
            // Accept any standard Indian broker exchange segment: NSE, BSE, NFO, BFO,
            // MCX, CDS, BCD, NCO and the canonical NSE_EQ / NSE_FO / NSE_CUR / MCX_FO.
            // This is the explicit-pair path used by clients that pre-resolve the
            // exchange. The leftover-pass above handles the same shape via UIR lookup.
            const validExchanges = new Set([
              'NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO',
              'NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'BCD', 'NCO', 'BSE_EQ',
            ]);
            if (validExchanges.has(ex) && Number.isFinite(tok)) {
              explicitPairs.push({ token: tok, exchange: ex });
              continue;
            }
          }
        }
        const n = Number(item);
        if (Number.isFinite(n)) numericTokens.push(n);
      }

      // Resolve exchanges for numeric tokens using provider (same precedence as Vayu REST)
      const provider = await this.providerResolver.resolveForWebsocket();
      let resolvedPairs: Array<{ token: number; exchange: any }> = [];
      try {
        const exMap: Map<string, any> = (provider as any)?.resolveExchanges
          ? await (provider as any).resolveExchanges(
              numericTokens.map((t) => String(t)),
            )
          : new Map();
        resolvedPairs = numericTokens
          .filter((t) => exMap.has(String(t)))
          .map((t) => ({ token: t, exchange: exMap.get(String(t)) }));
      } catch (e) {
        this.logger.warn(
          'Exchange resolution failed for tokens; proceeding with explicit pairs only',
          e as any,
        );
      }

      // Merge explicit pairs and resolved pairs; explicit wins on conflicts
      const pairByToken = new Map<number, any>();
      for (const p of resolvedPairs) pairByToken.set(p.token, p.exchange);
      for (const p of explicitPairs) pairByToken.set(p.token, p.exchange);

      let finalPairs: Array<{ token: number; exchange: any }> = Array.from(
        pairByToken.entries(),
      ).map(([token, exchange]) => ({ token, exchange }));

      const unresolved = numericTokens.filter((t) => !pairByToken.has(t));

      // Map exchange aliases to canonical form for entitlement check
      const normalizeExchangeAlias = (ex: string): string => {
        const aliasMap = new Map([
          // Client aliases → Canonical
          ['NFO', 'NSE_FO'],
          ['BFO', 'MCX_FO'],
          ['CDS', 'NSE_CUR'],
          ['BCD', 'NSE_CUR'],
          ['NCO', 'NSE_CUR'],
          // Canonical → canonical
          ['NSE_EQ', 'NSE_EQ'],
          ['NSE_FO', 'NSE_FO'],
          ['NSE_CUR', 'NSE_CUR'],
          ['MCX_FO', 'MCX_FO'],
          // Broker aliases → Canonical
          ['NSE', 'NSE_EQ'],
          ['BSE', 'BSE_EQ'],
          ['MCX', 'MCX_FO'],
        ]);
        return aliasMap.get(ex.toUpperCase()) || ex;
      };

      // Normalize exchanges to canonical form
      finalPairs = finalPairs.map((p) => ({
        ...p,
        exchange: normalizeExchangeAlias(String(p.exchange)),
      }));

      // Entitlement enforcement: filter pairs by allowed exchanges from API key metadata
      const record: any = (client.data as any)?.apiKeyRecord;
      const allowed = new Set(
        (Array.isArray(record?.metadata?.exchanges) &&
          record?.metadata?.exchanges) || [
          'NSE_EQ',
          'NSE_FO',
          'NSE_CUR',
          'MCX_FO',
        ],
      );
      const forbiddenPairs = finalPairs.filter(
        (p) => !allowed.has(String(p.exchange)),
      );
      finalPairs = finalPairs.filter((p) => allowed.has(String(p.exchange)));

      // Admin blocklist: filter out blocked exchanges
      const blockedExSet: Set<string> | undefined = (client as any)
        .__blockedExchanges;
      if (blockedExSet && blockedExSet.size > 0) {
        finalPairs = finalPairs.filter(
          (p) => !blockedExSet.has(String(p.exchange)),
        );
      }

      // Phase 3: resolve tokens to UIR IDs for internal tracking
      const providerNameForResolve =
        lockedProvider ?? this.streamService.activeProviderName;

      // Enforce per-connection instrument subscription cap (using UIR IDs)
      const maxInstruments =
        record?.ws_max_instruments != null &&
        Number.isFinite(record.ws_max_instruments) &&
        record.ws_max_instruments > 0
          ? record.ws_max_instruments
          : Number(process.env.WS_MAX_INSTRUMENTS ?? 3000);
      const currentInstrumentCount = subscription.instruments.length;
      // Pre-resolve to UIR IDs for limit check
      const preResolvedNewIds = finalPairs
        .map((p) => {
          const uirId = this.resolveUirForPair(providerNameForResolve, p);
          return uirId != null ? uirId : p.token;
        })
        .filter((id) => !new Set(subscription.instruments).has(id));
      const capacity = maxInstruments - currentInstrumentCount;
      if (capacity <= 0 && preResolvedNewIds.length > 0) {
        client.emit('error', {
          code: 'instrument_limit_exceeded',
          message: `Max ${maxInstruments} instruments per connection. Currently at ${currentInstrumentCount}.`,
          rejected_tokens: preResolvedNewIds,
          limit: maxInstruments,
          current: currentInstrumentCount,
        });
        // Keep only pairs whose UIR ID is already in subscription
        const existingSet = new Set(subscription.instruments);
        finalPairs = finalPairs.filter((p) => {
          const uirId = this.resolveUirForPair(providerNameForResolve, p);
          return existingSet.has(uirId != null ? uirId : p.token);
        });
      } else if (preResolvedNewIds.length > capacity) {
        const allowedNewIds = preResolvedNewIds.slice(0, capacity);
        const rejectedIds = preResolvedNewIds.slice(capacity);
        client.emit('error', {
          code: 'instrument_limit_exceeded',
          message: `Max ${maxInstruments} instruments per connection. ${rejectedIds.length} token(s) rejected.`,
          rejected_tokens: rejectedIds,
          limit: maxInstruments,
          current: currentInstrumentCount,
        });
        const allowedSet = new Set([
          ...subscription.instruments,
          ...allowedNewIds,
        ]);
        finalPairs = finalPairs.filter((p) => {
          const uirId = this.resolveUirForPair(providerNameForResolve, p);
          return allowedSet.has(uirId != null ? uirId : p.token);
        });
      }

      const includedTokens = finalPairs.map((p) => p.token);
      const includedUirIds: number[] = [];
      for (const p of finalPairs) {
        const uirId = this.resolveUirForPair(providerNameForResolve, p);
        if (uirId != null) {
          includedUirIds.push(uirId);
        } else {
          includedUirIds.push(p.token);
        }
      }
      const priorInstrumentSet = new Set(subscription.instruments);
      // Forced (provider-prefixed) UIR IDs — pinned to a specific provider via stream service param.
      const forcedUirIdsAll: number[] = Array.from(
        forcedByProvider.values(),
      ).flatMap((arr) => arr.map((e) => e.uirId));
      // Merge direct UIR IDs (massive/non-Indian instruments resolved via symbol lookup) + forced.
      const allIncludedUirIds = [
        ...includedUirIds,
        ...directUirIds,
        ...forcedUirIdsAll,
      ];
      subscription.instruments = [
        ...new Set([...subscription.instruments, ...allIncludedUirIds]),
      ];
      subscription.subscriptionType = type;
      allIncludedUirIds.forEach((id) => {
        subscription.modeByInstrument.set(id, mode);
      });

      // Subscribe upstream using UIR IDs — the stream service's subscriptionQueue is keyed by UIR IDs.
      const nonForcedUirIds = [...includedUirIds, ...directUirIds];
      if (nonForcedUirIds.length > 0) {
        this.logger.debug(
          `[MarketDataGateway] Subscribing client ${client.id} uirIds=${nonForcedUirIds.length} mode=${mode}`,
        );
        // Key-level provider lock is enforced at gateway (cross-provider prefix rejection above).
        // Do NOT pass lockedProvider as forcedProvider here — that would pin the UIR and disable
        // kite dual-subscribe, breaking the vortex→kite tick fallback in handleTicks.
        await this.streamService.subscribeToInstruments(
          nonForcedUirIds,
          mode,
          client.id,
        );
      }
      // Dispatch forced subscriptions per-provider so the stream service can pin routing.
      for (const [providerName, entries] of forcedByProvider) {
        const uirIds = entries.map((e) => e.uirId);
        this.logger.debug(
          `[MarketDataGateway] Subscribing client ${client.id} forced provider=${providerName} uirIds=${uirIds.length} mode=${mode}`,
        );
        await this.streamService.subscribeToInstruments(
          uirIds,
          mode,
          client.id,
          providerName,
        );
      }

      // Phase 3: join UIR-keyed rooms only
      const providerName =
        lockedProvider ?? this.streamService.activeProviderName;
      includedTokens.forEach((token) => {
        const uirId = this.instrumentRegistry.resolveProviderToken(
          providerName,
          token,
        );
        if (uirId != null) {
          client.join(`instrument:${uirId}`);
          this.addToRoom(`instrument:${uirId}`, client.id);
        } else {
          client.join(`instrument:${token}`);
          this.addToRoom(`instrument:${token}`, client.id);
        }
      });
      // Join rooms for direct UIR IDs (massive instruments) + forced provider-prefixed UIRs.
      directUirIds.forEach((id) => {
        client.join(`instrument:${id}`);
        this.addToRoom(`instrument:${id}`, client.id);
      });
      forcedUirIdsAll.forEach((id) => {
        client.join(`instrument:${id}`);
        this.addToRoom(`instrument:${id}`, client.id);
      });

      for (const id of allIncludedUirIds) {
        if (!priorInstrumentSet.has(id)) {
          this.wsInterest.addInterest(id);
        }
      }

      // Ack with details (Vortex: total = shards × 1000 per access token; Kite: 3000 upstream)
      let maxSubs = Number(process.env.KITE_TICKER_INSTRUMENT_LIMIT ?? 3000);
      try {
        const lim = (provider as any)?.getSubscriptionLimit?.();
        if (Number.isFinite(lim) && lim > 0) maxSubs = lim;
      } catch {}
      let vortexLimits: {
        perSocket: number;
        maxShards: number;
        total: number;
      } | null = null;
      try {
        vortexLimits = (provider as any)?.getVortexWsLimits?.() ?? null;
      } catch {}
      // Initial snapshot for included UIR IDs
      let snapshot: Record<string, { last_price: number | null }> = {};
      try {
        if (includedUirIds.length > 0) {
          snapshot = await this.streamService.getRecentLTP(
            includedUirIds.map((id) => String(id)),
          );
        }
      } catch {}
      // Queue sizes for backpressure transparency
      let queues: { subscribe: number; unsubscribe: number } | undefined;
      try {
        const qs = this.streamService.getQueueStatus();
        queues = {
          subscribe: qs.subscribe.size,
          unsubscribe: qs.unsubscribe.size,
        };
      } catch {}

      // Build symbol enrichment for included identifiers
      const symbolEnrichment: Array<{
        symbol: string;
        uirId: number;
        providerToken: number;
      }> = [];
      for (let i = 0; i < includedTokens.length; i++) {
        const token = includedTokens[i];
        const id = includedUirIds[i];
        const found = resolvedSymbols.find((r) => r.providerToken === token);
        if (found) {
          symbolEnrichment.push({
            symbol: found.symbol,
            uirId: found.uirId,
            providerToken: token,
          });
        } else {
          const sym = this.instrumentRegistry.getCanonicalSymbol(id);
          if (sym)
            symbolEnrichment.push({
              symbol: sym,
              uirId: id,
              providerToken: token,
            });
        }
      }

      client.emit('subscription_confirmed', {
        requested: requestedRaw,
        pairs: finalPairs.map((p) => `${p.exchange}-${p.token}`),
        included: allIncludedUirIds,
        resolved: symbolEnrichment.length > 0 ? symbolEnrichment : undefined,
        forced: forcedConfirm.length > 0 ? forcedConfirm : undefined,
        derivative: derivativeResolved.length > 0 ? derivativeResolved : undefined,
        unresolved,
        unresolvedSymbols:
          unresolvedSymbols.length > 0 ? unresolvedSymbols : undefined,
        forbidden: forbiddenPairs.map((p) => ({
          token: p.token,
          exchange: p.exchange,
        })),
        snapshot,
        mode,
        limits: {
          maxUpstreamInstruments: maxSubs,
          maxSubscriptionsPerSocket: maxInstruments,
          currentSubscriptions: subscription.instruments.length,
          ...(vortexLimits
            ? {
                maxVortexShards: vortexLimits.maxShards,
                maxVortexInstruments: vortexLimits.total,
              }
            : {}),
        },
        queues,
        timestamp: new Date().toISOString(),
      });

      // Metrics: count successful subscribe events per API key
      try {
        const apiKey: string =
          ((client.data as any)?.apiKey as string) || 'anonymous';
        this.metrics.wsEventsByApiKeyTotal.labels(apiKey, 'subscribe').inc();
      } catch {
        // Ignore metrics failures
      }

      // Optional sampled WS audit for subscribe events
      try {
        const record: any = (client.data as any)?.apiKeyRecord;
        const apiKey: string = (client.data as any)?.apiKey;
        const { ip, userAgent, origin } = this.extractWsOriginContext(client);
        this.originAudit
          .recordWsEvent({
            apiKey: apiKey || null,
            apiKeyId: (record as any)?.id ?? null,
            tenantId: (record as any)?.tenant_id ?? null,
            event: 'subscribe',
            status: null,
            ip,
            userAgent,
            origin,
            durationMs: null,
            country: null,
            asn: null,
            meta: {
              socketId: client.id,
              namespace: client.nsp?.name,
              requested: requestedRaw,
              included: includedTokens,
            },
          })
          .catch(() => {});
      } catch {
        // ignore audit failures
      }

      // For unresolved, emit guidance errors per token
      for (const t of unresolved) {
        client.emit('error', {
          code: 'exchange_unresolved',
          token: t,
          message:
            'Cannot auto-resolve exchange; please subscribe using EXCHANGE-TOKEN (e.g., NSE_FO-<token>)',
        });
      }

      // Forbidden pairs feedback
      for (const p of forbiddenPairs) {
        client.emit('error', {
          code: 'forbidden_exchange',
          token: p.token,
          exchange: p.exchange,
          message: 'Your API key is not entitled for this exchange',
        });
      }

      this.logger.log(
        `Client ${client.id} subscribed to ${includedTokens.length}/${requestedRaw.length} instruments with mode=${mode}; confirmed (unresolved=${unresolved.length})`,
      );
    } catch (error) {
      this.logger.error('Error handling instrument subscription', error);
      client.emit('error', {
        code: 'subscribe_failed',
        message: 'Failed to subscribe to instruments',
      });
    }
  }

  /**
   * Resolve a { token, exchange? } pair to a UIR ID.
   * For Vortex, tries the full "NSE_EQ-213123" key first (primary registry key),
   * then falls back to the numeric-only secondary key added in warmMaps().
   * For all other providers, delegates directly to resolveProviderToken.
   */
  private resolveUirForPair(
    provider: string,
    pair: { token: number; exchange?: any },
  ): number | undefined {
    if (provider === 'vortex' && pair.exchange) {
      const full = this.instrumentRegistry.resolveProviderToken(
        'vortex',
        `${pair.exchange}-${pair.token}`,
      );
      if (full != null) return full;
    }
    return this.instrumentRegistry.resolveProviderToken(provider, pair.token);
  }

  /**
   * Unsubscribe from market data for instruments
   *
   * Event: 'unsubscribe' (standard) or 'unsubscribe_instruments' (deprecated)
   *
   * @param data.instruments - Array of instrument tokens to unsubscribe from
   *
   * Events emitted:
   * - unsubscription_confirmed: When unsubscription succeeds
   * - error: When unsubscription fails
   *
   * @example
   * socket.emit('unsubscribe', { instruments: [26000] });
   */
  @SubscribeMessage('unsubscribe')
  async handleUnsubscribe(
    @MessageBody() data: { instruments: number[] },
    @ConnectedSocket() client: Socket,
  ) {
    return this.doUnsubscribe(data, client);
  }

  // Deprecated event name - kept for backward compatibility
  @SubscribeMessage('unsubscribe_instruments')
  async handleUnsubscribeInstruments(
    @MessageBody() data: { instruments: number[] },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.warn(
      `Client ${client.id} used deprecated event 'unsubscribe_instruments'. Please use 'unsubscribe' instead.`,
    );
    return this.doUnsubscribe(data, client);
  }

  // Internal handler
  private async doUnsubscribe(data: { instruments: number[] }, client: Socket) {
    try {
      const { instruments } = data as any;

      // Validate payload shape
      const v = validateUnsubscribePayload({ instruments });
      if (!v.ok) {
        client.emit('error', {
          code: 'invalid_payload',
          message: 'Invalid unsubscribe payload',
          errors: v.errors,
        });
        return;
      }

      // Rate limit per event (per API key, with optional per-key overrides)
      try {
        const record: any = (client.data as any)?.apiKeyRecord;
        const apiKey: string =
          ((client.data as any)?.apiKey as string) || client.id;
        const globalLimit = Number(process.env.WS_UNSUBSCRIBE_RPS || 10);
        const perKeyLimit = Number(record?.ws_unsubscribe_rps);
        const limit =
          Number.isFinite(perKeyLimit) && perKeyLimit > 0
            ? perKeyLimit
            : globalLimit;
        const rl = await this.apiKeyService.checkWsRateLimit(
          apiKey,
          'unsubscribe',
          limit,
        );
        if (rl) {
          client.emit('error', {
            code: 'rate_limited',
            message: 'Unsubscribe rate limit exceeded for this API key',
            limit,
            retry_after_ms: rl.retry_after_ms,
          });
          this.logger.warn(
            `[MarketDataGateway] Unsubscribe rate limit exceeded apiKey=${apiKey} limit=${limit} retry_after_ms=${rl.retry_after_ms}`,
          );
          return;
        }
      } catch {}

      const subscription = this.subscriptionRegistry.get(client.id);
      if (!subscription) {
        client.emit('error', { message: 'Client subscription not found' });
        return;
      }

      // Support numeric, EXCHANGE-TOKEN, or Provider:identifier (Falcon:reliance, Vayu:26000) inputs.
      const requestedRaw = Array.from(new Set(instruments as any));
      const requestedTokens: number[] = [];
      const requestedUirIds: number[] = [];
      for (const item of requestedRaw as any[]) {
        const prefixed = parseProviderPrefix(item);
        if (prefixed) {
          const result = this.instrumentRegistry.resolveProviderScopedSymbol(
            prefixed.provider,
            prefixed.identifier,
          );
          if (result.status === 'resolved') requestedUirIds.push(result.uirId);
          continue;
        }
        if (typeof item === 'string' && /-\d+$/.test(item)) {
          const tok = Number(String(item).split('-').pop());
          if (Number.isFinite(tok)) requestedTokens.push(tok);
        } else {
          const n = Number(item);
          if (Number.isFinite(n)) requestedTokens.push(n);
        }
      }

      // Phase 3: resolve incoming provider tokens to UIR IDs for matching internal state
      const providerNameForResolve = this.streamService.activeProviderName;
      for (const token of requestedTokens) {
        const uirId = this.instrumentRegistry.resolveProviderToken(
          providerNameForResolve,
          token,
        );
        requestedUirIds.push(uirId != null ? uirId : token);
      }

      // Remove instruments from subscription (keyed by UIR ID)
      const before = new Set(subscription.instruments);
      subscription.instruments = subscription.instruments.filter(
        (id) => !requestedUirIds.includes(id),
      );

      // Check if any other clients are subscribed to these UIR IDs
      const stillSubscribed = Array.from(
        this.subscriptionRegistry.values(),
      ).some((sub) =>
        sub.instruments.some((id) => requestedUirIds.includes(id)),
      );

      if (!stillSubscribed) {
        await this.unsubscribeFromInstruments(requestedUirIds, client.id);
      }

      // Leave UIR-keyed rooms
      requestedUirIds.forEach((id) => {
        client.leave(`instrument:${id}`);
        this.removeFromRoom(`instrument:${id}`, client.id);
      });

      const removed = Array.from(before).filter(
        (t) => !subscription.instruments.includes(t),
      );
      removed.forEach((id) => this.wsInterest.removeInterest(id));
      const not_found = requestedUirIds.filter((id) => !before.has(id));
      client.emit('unsubscription_confirmed', {
        requested: requestedTokens,
        removed,
        not_found,
        remaining: subscription.instruments,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(
        `Client ${client.id} unsubscribed from ${instruments.length} instruments`,
      );
      // Metrics: count successful unsubscribe events per API key
      try {
        const apiKey: string =
          ((client.data as any)?.apiKey as string) || 'anonymous';
        this.metrics.wsEventsByApiKeyTotal.labels(apiKey, 'unsubscribe').inc();
      } catch {
        // Ignore metrics failures
      }

      // Optional sampled WS audit for unsubscribe events
      try {
        const record: any = (client.data as any)?.apiKeyRecord;
        const apiKey: string = (client.data as any)?.apiKey;
        const { ip, userAgent, origin } = this.extractWsOriginContext(client);
        this.originAudit
          .recordWsEvent({
            apiKey: apiKey || null,
            apiKeyId: (record as any)?.id ?? null,
            tenantId: (record as any)?.tenant_id ?? null,
            event: 'unsubscribe',
            status: null,
            ip,
            userAgent,
            origin,
            durationMs: null,
            country: null,
            asn: null,
            meta: {
              socketId: client.id,
              namespace: client.nsp?.name,
              requested: requestedTokens,
              remaining: subscription.instruments,
            },
          })
          .catch(() => {});
      } catch {
        // ignore audit failures
      }
    } catch (error) {
      this.logger.error('Error handling instrument unsubscription', error);
      client.emit('error', {
        code: 'unsubscribe_failed',
        message: 'Failed to unsubscribe from instruments',
      });
    }
  }

  /**
   * Get real-time quote snapshot for instruments
   *
   * Retrieves current market data for instruments (snapshot, not streaming).
   * Checks Redis cache first, falls back to provider if not cached.
   *
   * @param data.instruments - Array of instrument tokens
   *
   * Events emitted:
   * - quote_data: Quote data (includes cached flag)
   * - error: When quote fetch fails
   *
   * @example
   * socket.emit('get_quote', { instruments: [26000, 11536] });
   * socket.on('quote_data', (data) => console.log(data));
   */
  @SubscribeMessage('get_quote')
  async handleGetQuote(
    @MessageBody() data: { instruments: number[]; ltp_only?: boolean },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const { instruments, ltp_only } = data;

      if (
        !instruments ||
        !Array.isArray(instruments) ||
        instruments.length === 0
      ) {
        client.emit('error', { message: 'Invalid instruments array' });
        return;
      }

      // Check cache first
      const cachedQuote = await this.redisService.getCachedQuote(
        instruments.map((token) => token.toString()),
      );

      if (cachedQuote) {
        client.emit('quote_data', {
          data: cachedQuote,
          cached: true,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Fetch via resolved HTTP provider (header routing is ignored for WS; global applies)
      const provider = await this.providerResolver.resolveForWebsocket();
      let quotes = await provider.getQuote(
        instruments.map((token) => token.toString()),
      );

      // Optional: filter only tokens with valid last_price
      if (ltp_only && quotes && typeof quotes === 'object') {
        const filtered: Record<string, any> = {};
        Object.entries(quotes).forEach(([k, v]: any) => {
          const lp = v?.last_price;
          if (Number.isFinite(lp) && lp > 0) filtered[k] = v;
        });
        quotes = filtered;
      }

      // Cache the result
      await this.redisService.cacheQuote(
        instruments.map((token) => token.toString()),
        quotes,
        30,
      );

      client.emit('quote_data', {
        data: quotes,
        cached: false,
        timestamp: new Date().toISOString(),
        ltp_only: !!ltp_only,
      });
    } catch (error) {
      this.logger.error('Error fetching quotes', error);
      client.emit('error', {
        code: 'quote_failed',
        message: 'Failed to fetch quotes',
      });
    }
  }

  /**
   * Identity and protocol details for the connected client
   * Event: 'whoami'
   */
  @SubscribeMessage('whoami')
  async handleWhoAmI(@ConnectedSocket() client: Socket) {
    try {
      const record: any = (client.data as any)?.apiKeyRecord;
      const apiKey: string = (client.data as any)?.apiKey;
      const usage = await this.apiKeyService.getUsageReport(apiKey);
      const exchanges = (Array.isArray(record?.metadata?.exchanges) &&
        record?.metadata?.exchanges) || [
        'NSE_EQ',
        'NSE_FO',
        'NSE_CUR',
        'MCX_FO',
      ];
      const limits: Record<string, any> = {
        connection: record?.connection_limit || 3,
        maxUpstreamInstruments: Number(
          process.env.KITE_TICKER_INSTRUMENT_LIMIT ?? 3000,
        ),
        maxSubscriptionsPerSocket:
          record?.ws_max_instruments ??
          Number(process.env.WS_MAX_INSTRUMENTS ?? 3000),
      };
      try {
        const provider = await this.providerResolver.resolveForWebsocket();
        const lim = (provider as any)?.getSubscriptionLimit?.();
        if (Number.isFinite(lim) && lim > 0) {
          limits.maxUpstreamInstruments = lim;
        }
        const v = (provider as any)?.getVortexWsLimits?.() ?? null;
        if (v) {
          limits.maxSubscriptionsPerSocket =
            record?.ws_max_instruments ?? v.perSocket;
          limits.maxVortexShards = v.maxShards;
          limits.maxVortexInstruments = v.total;
        }
      } catch {}

      const sub = this.subscriptionRegistry.get(client.id);
      const tokens = sub?.instruments || [];
      const modes: Record<number, string> = {};
      sub?.modeByInstrument?.forEach((m, t) => (modes[t] = m));

      const lockedKeyProv = normalizeProviderAlias(
        ((client.data as any).apiKeyRecord as any)?.provider ?? null,
      );
      const internalWho =
        lockedKeyProv ??
        (await this.providerResolver.getResolvedInternalProviderNameForWebsocket());
      const clientProviderWho = internalToClientProviderName(internalWho);

      // Resolve pairs for better diagnostics
      let pairs: string[] = [];
      try {
        const provider = await this.providerResolver.resolveForWebsocket();
        const exMap: Map<string, any> = (provider as any)?.resolveExchanges
          ? await (provider as any).resolveExchanges(
              tokens.map((t) => String(t)),
            )
          : new Map();
        pairs = tokens
          .filter((t) => exMap.has(String(t)))
          .map((t) => `${exMap.get(String(t))}-${t}`);
      } catch {}

      client.emit('whoami', {
        protocol_version: PROTOCOL_VERSION,
        provider: clientProviderWho,
        apiKey: {
          tenant: record?.tenant_id || 'unknown',
          httpRequestsThisMinute: usage?.httpRequestsThisMinute || 0,
          currentWsConnections: usage?.currentWsConnections || 0,
        },
        entitlements: { exchanges },
        limits,
        subscriptions: { tokens, pairs, modes, count: tokens.length },
        server_time: new Date().toISOString(),
      });
    } catch (e) {
      this.logger.warn('whoami failed', e as any);
      client.emit('error', {
        code: 'whoami_failed',
        message: 'Failed to retrieve identity',
      });
    }
  }

  /**
   * Get historical market data for an instrument
   *
   * @param data.instrumentToken - Instrument token
   * @param data.fromDate - Start date (YYYY-MM-DD)
   * @param data.toDate - End date (YYYY-MM-DD)
   * @param data.interval - Time interval: 'minute', 'hour', 'day'
   *
   * Events emitted:
   * - historical_data: Historical data array
   * - error: When historical data fetch fails
   *
   * @example
   * socket.emit('get_historical_data', {
   *   instrumentToken: 26000,
   *   fromDate: '2024-01-01',
   *   toDate: '2024-01-31',
   *   interval: 'day'
   * });
   */
  @SubscribeMessage('get_historical_data')
  async handleGetHistoricalData(
    @MessageBody()
    data: {
      instrumentToken: number;
      fromDate: string;
      toDate: string;
      interval: string;
    },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const { instrumentToken, fromDate, toDate, interval } = data;

      const provider = await this.providerResolver.resolveForWebsocket();
      const historicalData = await provider.getHistoricalData(
        instrumentToken,
        fromDate,
        toDate,
        interval,
      );

      client.emit('historical_data', {
        instrumentToken,
        data: historicalData,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error fetching historical data', error);
      client.emit('error', {
        code: 'historical_failed',
        message: 'Failed to fetch historical data',
      });
    }
  }

  /**
   * Set mode for subscribed instruments
   * Event: 'set_mode'
   * Body: { instruments: (number|string)[], mode: 'ltp'|'ohlcv'|'full' }
   */
  @SubscribeMessage('set_mode')
  async handleSetMode(
    @MessageBody()
    body: {
      instruments: Array<number | string>;
      mode: 'ltp' | 'ohlcv' | 'full';
    },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const { instruments, mode } = body as any;
      const subscription = this.subscriptionRegistry.get(client.id);
      if (!subscription) {
        client.emit('error', {
          code: 'not_connected',
          message: 'No active subscription context',
        });
        return;
      }

      // Rate limit per event (per API key, with optional per-key overrides)
      try {
        const record: any = (client.data as any)?.apiKeyRecord;
        const apiKey: string =
          ((client.data as any)?.apiKey as string) || client.id;
        const globalLimit = Number(process.env.WS_MODE_RPS || 20);
        const perKeyLimit = Number(record?.ws_mode_rps);
        const limit =
          Number.isFinite(perKeyLimit) && perKeyLimit > 0
            ? perKeyLimit
            : globalLimit;
        const rl = await this.apiKeyService.checkWsRateLimit(
          apiKey,
          'set_mode',
          limit,
        );
        if (rl) {
          client.emit('error', {
            code: 'rate_limited',
            message: 'Set mode rate limit exceeded for this API key',
            limit,
            retry_after_ms: rl.retry_after_ms,
          });
          this.logger.warn(
            `[MarketDataGateway] Set mode rate limit exceeded apiKey=${apiKey} limit=${limit} retry_after_ms=${rl.retry_after_ms}`,
          );
          return;
        }
      } catch {}

      // Validate
      const val = validateSetModePayload({ instruments, mode });
      if (!val.ok) {
        client.emit('error', {
          code: 'invalid_payload',
          message: 'Invalid set_mode payload',
          errors: val.errors,
        });
        return;
      }

      // Parse targets — incoming tokens are provider tokens, resolve to UIR IDs
      const requestedRaw = Array.from(new Set(instruments as any));
      const tokens: number[] = [];
      for (const item of requestedRaw as any[]) {
        if (typeof item === 'string' && /-\d+$/.test(item)) {
          const tok = Number(String(item).split('-').pop());
          if (Number.isFinite(tok)) tokens.push(tok);
        } else {
          const n = Number(item);
          if (Number.isFinite(n)) tokens.push(n);
        }
      }

      // Phase 3: resolve provider tokens to UIR IDs for matching internal state
      const providerNameForResolve = this.streamService.activeProviderName;
      const uirIds: number[] = [];
      for (const token of tokens) {
        const uirId = this.instrumentRegistry.resolveProviderToken(
          providerNameForResolve,
          token,
        );
        uirIds.push(uirId != null ? uirId : token);
      }

      const subscribedSet = new Set(subscription.instruments);
      const target = uirIds.filter((id) => subscribedSet.has(id));
      const not_subscribed = uirIds.filter((id) => !subscribedSet.has(id));

      if (target.length > 0) {
        await this.streamService.setMode(mode, target);
        target.forEach((id) => subscription.modeByInstrument.set(id, mode));
      }

      client.emit('mode_set', {
        requested: tokens,
        updated: target,
        not_subscribed,
        mode,
        timestamp: new Date().toISOString(),
      });

      // Metrics: count successful set_mode events per API key
      try {
        const apiKey: string =
          ((client.data as any)?.apiKey as string) || 'anonymous';
        this.metrics.wsEventsByApiKeyTotal.labels(apiKey, 'set_mode').inc();
      } catch {
        // Ignore metrics failures
      }
    } catch (e) {
      this.logger.error('Error handling set_mode', e);
      client.emit('error', {
        code: 'set_mode_failed',
        message: 'Failed to set mode',
      });
    }
  }

  /**
   * List current subscriptions for this client
   * Event: 'list_subscriptions'
   */
  @SubscribeMessage('list_subscriptions')
  async handleListSubscriptions(@ConnectedSocket() client: Socket) {
    try {
      const sub = this.subscriptionRegistry.get(client.id);
      const tokens = sub?.instruments || [];
      const modes: Record<number, string> = {};
      sub?.modeByInstrument?.forEach((m, t) => (modes[t] = m));
      let pairs: string[] = [];
      try {
        const provider = await this.providerResolver.resolveForWebsocket();
        const exMap: Map<string, any> = (provider as any)?.resolveExchanges
          ? await (provider as any).resolveExchanges(
              tokens.map((t) => String(t)),
            )
          : new Map();
        pairs = tokens
          .filter((t) => exMap.has(String(t)))
          .map((t) => `${exMap.get(String(t))}-${t}`);
      } catch {}
      client.emit('subscriptions', {
        tokens,
        modes,
        pairs,
        count: tokens.length,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      this.logger.warn('list_subscriptions failed', e as any);
      client.emit('error', {
        code: 'list_failed',
        message: 'Failed to list subscriptions',
      });
    }
  }

  /**
   * Unsubscribe all tokens for this client
   * Event: 'unsubscribe_all'
   */
  @SubscribeMessage('unsubscribe_all')
  async handleUnsubscribeAll(@ConnectedSocket() client: Socket) {
    try {
      const sub = this.subscriptionRegistry.get(client.id);
      const ids = sub?.instruments || [];
      if (ids.length > 0) {
        ids.forEach((id) => this.wsInterest.removeInterest(id));
        await this.unsubscribeFromInstruments(ids, client.id);
        ids.forEach((id) => {
          client.leave(`instrument:${id}`);
          this.removeFromRoom(`instrument:${id}`, client.id);
        });
      }
      if (sub) {
        sub.instruments = [];
        sub.modeByInstrument.clear();
      }
      client.emit('unsubscribed_all', {
        removed_count: ids.length,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      this.logger.warn('unsubscribe_all failed', e as any);
      client.emit('error', {
        code: 'unsubscribe_all_failed',
        message: 'Failed to unsubscribe all',
      });
    }
  }

  /**
   * Ping: client can compute RTT; server returns server time
   */
  @SubscribeMessage('ping')
  async handlePing(@ConnectedSocket() client: Socket) {
    client.emit('pong', { t: Date.now(), protocol_version: PROTOCOL_VERSION });
  }

  /**
   * Status: return gateway stats and provider streaming status
   */
  @SubscribeMessage('status')
  async handleStatus(@ConnectedSocket() client: Socket) {
    try {
      const stream = await this.streamService.getStreamingStatus();
      const sub = this.subscriptionRegistry.get(client.id);
      const stats = this.getConnectionStats();
      client.emit('status', {
        protocol_version: PROTOCOL_VERSION,
        streaming: stream,
        gateway: {
          totalConnections: stats.totalConnections,
          yourSubscriptions: sub?.instruments?.length || 0,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      this.logger.warn('status failed', e as any);
      client.emit('error', {
        code: 'status_failed',
        message: 'Failed to get status',
      });
    }
  }

  private async subscribeToInstruments(
    instruments: number[],
    mode: 'ltp' | 'ohlcv' | 'full' = 'ltp',
    clientId?: string,
  ) {
    try {
      const status = await this.streamService.getStreamingStatus();
      if (!status?.isStreaming) {
        this.logger.warn(
          'subscribeToInstruments ignored: streaming not active',
        );
        return;
      }
      await this.streamService.subscribeToInstruments(
        instruments,
        mode,
        clientId,
      );
      this.logger.log(
        `[Gateway] Queued subscription for ${instruments.length} instruments with mode=${mode} for client=${clientId}`,
      );
    } catch (error) {
      this.logger.error('Error queuing instrument subscriptions', error);
    }
  }

  private async unsubscribeFromInstruments(
    instruments: number[],
    clientId?: string,
  ) {
    try {
      const status = await this.streamService.getStreamingStatus();
      if (!status?.isStreaming) {
        this.logger.warn(
          'unsubscribeFromInstruments ignored: streaming not active',
        );
        return;
      }
      await this.streamService.unsubscribeFromInstruments(
        instruments,
        clientId,
      );
      this.logger.log(
        `[Gateway] Queued unsubscription for ${instruments.length} instruments for client=${clientId}`,
      );
    } catch (error) {
      this.logger.error('Error queuing instrument unsubscriptions', error);
    }
  }

  /**
   * Broadcast market data to subscribed clients
   *
   * Called by MarketDataStreamService when new tick data arrives.
   * Uses Socket.IO rooms for efficient targeted broadcasting.
   *
   * @param instrumentToken - Instrument token
   * @param data - Market data payload (varies by mode: ltp/ohlcv/full)
   *
   * Broadcasting:
   * - Uses room-based broadcast: server.to(`instrument:${token}`)
   * - Only sends to clients subscribed to this instrument
   * - Logs latency for performance monitoring
   *
   * @performance <5ms broadcast latency for 100 clients
   */
  /**
   * Broadcast market data to subscribed clients.
   * @param identifier UIR ID (Phase 3 primary) — matches room `instrument:{uirId}`.
   */
  async broadcastMarketData(
    identifier: number,
    data: any,
    emitOpts?: MarketTickEmitOptions,
  ) {
    try {
      const startTime = Date.now();
      const room = `instrument:${identifier}`;

      // O(1) lookup via in-memory Map instead of Socket.IO's O(n) fetchSockets()
      // this.server IS the /market-data Namespace (set by @WebSocketGateway(namespace='/market-data')).
      // Namespaces expose .sockets as a Map<socketId, Socket>.
      const memberIds = this.roomMembers.get(room);
      if (!memberIds?.size) return;

      // Namespace.sockets is a Map<socketId, Socket> — use it directly with optional chaining.
      const namespaceSockets = (this.server as any).sockets as Map<string, Socket> | undefined;
      const rawSockets: Socket[] = [];
      if (namespaceSockets) {
        for (const socketId of memberIds) {
          const s = namespaceSockets.get(socketId);
          if (s) rawSockets.push(s);
        }
      }
      if (rawSockets.length === 0) return;

      const ts = new Date().toISOString();
      const now = Date.now();

      // Pre-compute canonical-prefix identifier map ONCE per tick (not per subscriber).
      // Hot path: O(1) Map lookups against the warm InstrumentRegistryService.
      // Each subscriber reuses these primitives, so the room can have hundreds of
      // sockets without re-querying the registry per-socket.
      const activeProvider: InternalProviderName =
        this.streamService.activeProviderName;
      const providerTokensMap =
        this.instrumentRegistry.getProviderTokens(identifier);
      const canonicalSymbol =
        this.instrumentRegistry.getCanonicalSymbol(identifier);

      if (!providerTokensMap) {
        // Guard: should never happen for an actively-subscribed UIR, but log if it
        // does so the orchestrator can spot registry/gateway drift early.
        this.logger.debug(
          `[Gateway] No provider token map for UIR ${identifier} (activeProvider=${activeProvider})`,
        );
      }

      // Build the identifiers object (provider → token) once. Coerce numeric Kite
      // tokens to string so the wire format is consistent across providers.
      const identifiers: Record<string, string> = {};
      if (providerTokensMap) {
        for (const [provider, token] of providerTokensMap.entries()) {
          if (token == null) continue;
          identifiers[provider] = String(token);
        }
      }
      const activeProviderToken = providerTokensMap?.get(activeProvider);

      for (const s of rawSockets) {
        const sub = this.subscriptionRegistry.get(s.id);
        const apiKey = sub?.apiKey || (s.data as any)?.apiKey;

        // Per-key trailing-edge throttle (additional gate on top of global stream throttle)
        const keyThrottleMs = apiKey
          ? (this.apiKeyThrottleMs.get(apiKey) ?? 0)
          : 0;
        if (keyThrottleMs > 0) {
          const socketMap = this.perSocketLastSent.get(s.id);
          const lastSent = socketMap?.get(identifier) ?? 0;
          if (now - lastSent < keyThrottleMs) continue;
          socketMap?.set(identifier, now);
        }

        const mode: StreamTickMode =
          sub?.modeByInstrument?.get(identifier) || 'ltp';
        const payload = shapeMarketTickForMode(data, mode);
        const emitPayload = {
          instrumentToken: data?.instrument_token ?? identifier,
          uirId: identifier,
          canonical: canonicalSymbol,
          identifiers,
          activeProvider,
          activeProviderToken:
            activeProviderToken != null ? String(activeProviderToken) : undefined,
          data: payload,
          timestamp: ts,
          ...(emitOpts?.syntheticLast ? { syntheticLast: true } : {}),
        };
        s.emit('market_data', emitPayload);

        // Accumulate approximate bytes per API key (flushed to Redis every 10s)
        if (apiKey) {
          const approxBytes = Buffer.byteLength(JSON.stringify(emitPayload));
          this.bytesAccumulator.set(
            apiKey,
            (this.bytesAccumulator.get(apiKey) ?? 0) + approxBytes,
          );
        }
      }

      const broadcastTime = Date.now() - startTime;
      this.logger.debug(
        `[Gateway] Broadcasted tick UIR ${identifier} to ${rawSockets.length} clients in ${broadcastTime}ms`,
      );
    } catch (error) {
      this.logger.error('[Gateway] Error broadcasting market data', error);
    }
  }

  // Method to get connection statistics
  getConnectionStats() {
    const byApiKeyMap = new Map<
      string,
      { connections: number; totalSubscribedInstruments: number }
    >();

    for (const sub of this.subscriptionRegistry.values()) {
      const apiKey = sub.apiKey || 'anonymous';
      const current = byApiKeyMap.get(apiKey) || {
        connections: 0,
        totalSubscribedInstruments: 0,
      };
      current.connections += 1;
      current.totalSubscribedInstruments += sub.instruments.length;
      byApiKeyMap.set(apiKey, current);
    }

    const byApiKey = Array.from(byApiKeyMap.entries()).map(
      ([apiKey, stats]) => ({
        apiKey,
        connections: stats.connections,
        totalSubscribedInstruments: stats.totalSubscribedInstruments,
      }),
    );

    return {
      totalConnections: this.subscriptionRegistry.size,
      subscriptions: Array.from(this.subscriptionRegistry.values()).map(
        (sub) => ({
          userId: sub.userId,
          instrumentCount: sub.instruments.length,
          subscriptionType: sub.subscriptionType,
          apiKey: sub.apiKey || 'anonymous',
        }),
      ),
      byApiKey,
    };
  }

  getApiKeyLiveDetail(apiKey: string): {
    liveConnections: number;
    liveSubscriptions: number;
    sockets: Array<{
      socketId: string;
      instruments: number;
      connectedAt: string | null;
      origin: string | null;
      ip: string | null;
      userAgent: string | null;
    }>;
  } {
    const matchingSubs = Array.from(this.subscriptionRegistry.values()).filter(
      (sub) => sub.apiKey === apiKey,
    );

    const sockets = matchingSubs.map((sub) => {
      const s = this.server?.sockets?.sockets?.get(sub.socketId);
      const data = (s?.data as any) ?? {};
      const ctx = s
        ? this.extractWsOriginContext(s)
        : { ip: null, userAgent: null, origin: null };
      return {
        socketId: sub.socketId,
        instruments: sub.instruments.length,
        connectedAt: data.connectedAt ?? null,
        origin: ctx.origin,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      };
    });

    return {
      liveConnections: matchingSubs.length,
      liveSubscriptions: matchingSubs.reduce(
        (sum, s) => sum + s.instruments.length,
        0,
      ),
      sockets,
    };
  }

  /**
   * Manually disconnect a socket by ID (Admin action).
   */
  async disconnectSocket(socketId: string): Promise<boolean> {
    const socket = this.server?.sockets?.sockets?.get(socketId);
    if (!socket) return false;
    this.logger.log(
      `[Gateway] Admin-initiated disconnect for socket: ${socketId}`,
    );
    socket.emit('error', {
      code: 'admin_disconnect',
      message: 'Your connection was terminated by an administrator',
    });
    socket.disconnect(true);
    return true;
  }

  /**
   * Comprehensive stats for the Watch Page.
   */
  getAllWatchStats() {
    const allSockets = Array.from(this.subscriptionRegistry.values()).map(
      (sub) => {
        const s = this.server?.sockets?.sockets?.get(sub.socketId);
        const data = (s?.data as any) ?? {};
        const ctx = s
          ? this.extractWsOriginContext(s)
          : { ip: null, userAgent: null, origin: null };
        return {
          socketId: sub.socketId,
          apiKey: sub.apiKey || 'anonymous',
          instruments: sub.instruments.length,
          connectedAt: data.connectedAt ?? null,
          origin: ctx.origin,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        };
      },
    );

    return {
      totalConnections: this.subscriptionRegistry.size,
      sockets: allSockets,
    };
  }

  private async flushBytesAccumulator(): Promise<void> {
    if (this.bytesAccumulator.size === 0) return;
    const snapshot = new Map(this.bytesAccumulator);
    this.bytesAccumulator.clear();
    for (const [key, bytes] of snapshot) {
      try {
        await this.apiKeyService.incrementBytesSent(key, bytes);
        this.bytesFlushRetryCount.delete(key);
      } catch (err) {
        const retries = (this.bytesFlushRetryCount.get(key) ?? 0) + 1;
        this.bytesFlushRetryCount.set(key, retries);
        if (retries < MarketDataGateway.BYTES_FLUSH_MAX_RETRIES) {
          // Re-queue for next flush cycle
          const existing = this.bytesAccumulator.get(key) ?? 0;
          this.bytesAccumulator.set(key, existing + bytes);
          this.logger.warn(
            `[Gateway] Failed to flush bytes for key=${key} (retry ${retries}/${MarketDataGateway.BYTES_FLUSH_MAX_RETRIES}), re-queued ${bytes} bytes`,
            err instanceof Error ? err.message : String(err),
          );
        } else {
          // Exhausted retries — log error and increment metric
          this.logger.error(
            `[Gateway] Exhausted bytes flush retries for key=${key} after ${retries} failures, dropping ${bytes} bytes`,
            err instanceof Error ? err.stack : String(err),
          );
          this.metrics.marketDataBytesFlushFailedTotal.inc({ api_key: key });
          this.bytesFlushRetryCount.delete(key);
        }
      }
    }
  }

  /**
   * Extract origin context (IP, UA, Origin) from a Socket.IO client handshake.
   */
  private extractWsOriginContext(client: Socket): {
    ip: string | null;
    userAgent: string | null;
    origin: string | null;
  } {
    try {
      const headers = (client.handshake && client.handshake.headers) || {};
      const xfwd = headers['x-forwarded-for'] as string | string[] | undefined;
      let ip: string | null = null;
      if (Array.isArray(xfwd)) {
        ip = xfwd[0];
      } else if (typeof xfwd === 'string' && xfwd.length > 0) {
        ip = xfwd.split(',')[0]?.trim() || null;
      }
      if (!ip) {
        ip =
          (client.handshake && (client.handshake.address as string)) ||
          (client.conn && (client.conn.remoteAddress as string)) ||
          null;
      }

      const userAgent =
        (headers['user-agent'] as string) ||
        (headers['User-Agent'] as string) ||
        null;
      const originHeader =
        (headers['origin'] as string) ||
        (headers['Origin'] as string) ||
        (headers['referer'] as string) ||
        (headers['Referer'] as string) ||
        null;

      return {
        ip: ip || null,
        userAgent: userAgent || null,
        origin: originHeader || null,
      };
    } catch {
      return { ip: null, userAgent: null, origin: null };
    }
  }
}
