/**
 * @file native-ws.service.ts
 * @module market-data
 * @description Native WebSocket /ws endpoint: API key auth, subscriptions, tick broadcast with mode shaping.
 * @author BharatERP
 * @created 2025-03-23
 * @updated 2026-04-27
 * Changelog: added symbols[] canonical subscription support in handleSubscribe
 */
import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  OnModuleDestroy,
} from '@nestjs/common';
import { Server as WSServer, WebSocket } from 'ws';
import { RedisService } from '@infra/redis/redis.service';
import { MarketDataProviderResolverService } from '@features/market-data/application/market-data-provider-resolver.service';
import { ApiKeyService } from '@features/auth/application/api-key.service';
import { MarketDataStreamService } from '@features/market-data/application/market-data-stream.service';
import {
  shapeMarketTickForMode,
  StreamTickMode,
  MarketTickEmitOptions,
} from '@features/market-data/application/tick-shape.util';
import { MarketDataWsInterestService } from '@features/market-data/application/market-data-ws-interest.service';
import { validateSetModePayload } from '@shared/utils/ws-validation';
import { InstrumentRegistryService } from '@features/market-data/application/instrument-registry.service';

interface ClientSubscription {
  clientId: string;
  userId: string;
  instruments: number[];
  subscriptionType: 'live' | 'historical' | 'both';
  modeByInstrument: Map<number, 'ltp' | 'ohlcv' | 'full'>;
}

interface HeartbeatWebSocket extends WebSocket {
  apiKey?: string;
  clientId?: string;
  isAlive?: boolean;
}

@Injectable()
export class NativeWsService implements OnModuleDestroy {
  private readonly logger = new Logger(NativeWsService.name);
  private server: WSServer | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private clientSubscriptions = new Map<string, ClientSubscription>();

  constructor(
    private readonly redisService: RedisService,
    private readonly providerResolver: MarketDataProviderResolverService,
    private readonly apiKeyService: ApiKeyService,
    @Inject(forwardRef(() => MarketDataStreamService))
    private readonly streamService: MarketDataStreamService,
    private readonly wsInterest: MarketDataWsInterestService,
    private readonly instrumentRegistry: InstrumentRegistryService,
  ) {}

  /**
   * Initialize a native WebSocket server bound to the provided HTTP server.
   * Path should be '/ws' to match Nginx location and client URLs.
   */
  async init(httpServer: any, path: string = '/ws') {
    if (this.server) {
      this.logger.warn('Native WS server already initialized');
      return;
    }

    // Use noServer mode and manually handle upgrades to avoid interfering with Socket.IO
    this.server = new WSServer({ noServer: true });

    // Attach upgrade handler to the underlying HTTP server
    try {
      httpServer.on('upgrade', (request: any, socket: any, head: any) => {
        try {
          const { pathname } = new URL(request.url, 'http://dummy');
          if (pathname !== path) {
            // Not our endpoint; let other handlers (e.g., Socket.IO) process it
            return;
          }
          // Handle only /ws upgrades
          this.server!.handleUpgrade(request, socket, head, (ws) => {
            (this.server as WSServer).emit('connection', ws, request);
          });
        } catch (e) {
          this.logger.error('Upgrade handler error', e as any);
        }
      });
    } catch (e) {
      this.logger.error('Failed to attach HTTP upgrade listener', e as any);
    }

    this.server.on('connection', (client: HeartbeatWebSocket, request) => {
      try {
        client.isAlive = true;
        client.on('pong', () => (client.isAlive = true));
        this.handleConnection(client, request);

        client.on('close', () => {
          try {
            this.handleDisconnect(client);
          } catch (e) {
            this.logger.warn('Error in handleDisconnect', e as any);
          }
        });

        client.on('error', (err) => {
          this.logger.error('Client WS error', err as any);
        });
      } catch (e) {
        this.logger.error('Error during WS connection setup', e as any);
      }
    });

    this.server.on('error', (err) => {
      this.logger.error('WS server error', err as any);
    });

    // Heartbeat to detect dead peers
    this.heartbeatInterval = setInterval(() => {
      try {
        this.server?.clients.forEach((ws: any) => {
          const client = ws as HeartbeatWebSocket;
          if (client.isAlive === false) {
            try {
              client.terminate();
            } catch {}
            return;
          }
          client.isAlive = false;
          try {
            client.ping();
          } catch {}
        });
      } catch (e) {
        this.logger.warn('Heartbeat interval error', e as any);
      }
    }, 30000);

    this.logger.log(`Native WebSocket server initialized on path ${path}`);
  }

  onModuleDestroy() {
    try {
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      if (this.server) {
        try {
          this.server.close();
        } catch {}
        this.server = null;
      }
    } catch (e) {
      this.logger.warn('Error during WS server shutdown', e as any);
    }
  }

  private async handleConnection(client: HeartbeatWebSocket, request: any) {
    const clientId = `native-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 9)}`;
    client.clientId = clientId;

    this.logger.log(`Native WebSocket client connected: ${clientId}`);

    // Parse query parameters for API key
    const url = new URL(request.url, 'http://dummy.com');
    const apiKey =
      url.searchParams.get('api_key') || request.headers['x-api-key'] || '';

    if (!apiKey) {
      this.sendError(
        client,
        'WS_AUTH_MISSING',
        'Missing API key. Include ?api_key=YOUR_KEY in connection URL.',
      );
      client.close(1008, 'Missing API key');
      return;
    }

    try {
      // Validate API key
      const record = await this.apiKeyService.validateApiKey(apiKey);
      if (!record) {
        this.sendError(client, 'WS_AUTH_INVALID', 'Invalid API key');
        client.close(1008, 'Invalid API key');
        return;
      }

      // Track connection
      await this.apiKeyService.trackWsConnection(
        apiKey,
        record.connection_limit,
      );
      client.apiKey = apiKey;

      // Initialize subscription
      this.clientSubscriptions.set(clientId, {
        clientId,
        userId: 'anonymous',
        instruments: [],
        subscriptionType: 'live',
        modeByInstrument: new Map(),
      });

      // Send connection confirmation
      this.sendToClient(client, 'connected', {
        message: 'Connected to market data stream',
        clientId: clientId,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      this.logger.warn(
        `Connection rejected for ${clientId}: ${err?.message || err}`,
      );
      this.sendError(
        client,
        'WS_CONNECTION_ERROR',
        err?.message || 'Connection failed',
      );
      client.close(1011, 'Internal error');
      return;
    }

    // Parse incoming messages
    client.on('message', (data: Buffer) => {
      this.handleMessage(client, data.toString());
    });
  }

  private async handleDisconnect(client: HeartbeatWebSocket) {
    const clientId = client.clientId || 'unknown';
    this.logger.log(`Native WebSocket client disconnected: ${clientId}`);

    const subscription = this.clientSubscriptions.get(clientId);
    if (subscription) {
      // Unsubscribe from instruments
      if (subscription.instruments.length > 0) {
        for (const t of subscription.instruments) {
          this.wsInterest.removeInterest(t);
        }
        await this.unsubscribeFromInstruments(
          subscription.instruments,
          clientId,
        );
      }
      this.clientSubscriptions.delete(clientId);
    }

    // Untrack connection
    try {
      const apiKey = client.apiKey;
      if (apiKey) {
        await this.apiKeyService.untrackWsConnection(apiKey);
      }
    } catch (e) {
      this.logger.warn(`Failed to untrack connection for ${clientId}`);
    }
  }

  private handleMessage(client: HeartbeatWebSocket, message: string) {
    try {
      const parsed = JSON.parse(message);
      const { event, data } = parsed;

      switch (event) {
        case 'subscribe':
          this.handleSubscribe(client, data);
          break;
        case 'unsubscribe':
          this.handleUnsubscribe(client, data);
          break;
        case 'set_mode':
          void this.handleSetMode(client, data);
          break;
        case 'get_quote':
          this.handleGetQuote(client, data);
          break;
        case 'get_historical_data':
          this.handleGetHistoricalData(client, data);
          break;
        case 'ping':
          this.sendToClient(client, 'pong', { timestamp: Date.now() });
          break;
        default:
          this.sendError(client, 'WS_UNKNOWN_EVENT', `Unknown event: ${event}`);
      }
    } catch (error) {
      this.logger.error('Error parsing message', error as any);
      this.sendError(
        client,
        'WS_INVALID_MESSAGE',
        'Invalid JSON message format',
      );
    }
  }

  private async handleSubscribe(client: HeartbeatWebSocket, data: any) {
    const clientId = client.clientId || 'unknown';
    const subscription = this.clientSubscriptions.get(clientId);

    if (!subscription) {
      this.sendError(
        client,
        'WS_SUBSCRIPTION_NOT_FOUND',
        'Client subscription not found',
      );
      return;
    }

    const { instruments: rawInstruments = [], symbols = [], mode = 'ltp' } = data || {};

    // Parse instruments: accept both numeric tokens and Vortex EXCHANGE-TOKEN strings (e.g. "NSE_EQ-213123").
    const vortexPairs: Array<{ token: number; exchange: string }> = [];
    const numericInstruments: number[] = [];
    for (const item of rawInstruments as any[]) {
      if (typeof item === 'string') {
        const m = String(item).trim().toUpperCase().match(/^([A-Z_]+)-(\d+)$/);
        if (m && ['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO'].includes(m[1])) {
          const tok = Number(m[2]);
          if (Number.isFinite(tok)) { vortexPairs.push({ token: tok, exchange: m[1] }); continue; }
        }
      }
      const n = Number(item);
      if (Number.isFinite(n)) numericInstruments.push(n);
    }

    // Resolve symbols to provider tokens — accepts canonical ("NSE:RELIANCE") and plain names ("RELIANCE").
    const resolvedSymbolTokens: number[] = [];
    const unresolvedSymbols: string[] = [];
    if (Array.isArray(symbols) && symbols.length > 0) {
      const providerName = this.streamService.activeProviderName;
      for (const sym of symbols as string[]) {
        const flexResult = this.instrumentRegistry.resolveFlexSymbol(sym);
        if (flexResult.status === 'not_found') { unresolvedSymbols.push(sym); continue; }
        if (flexResult.status === 'ambiguous') {
          unresolvedSymbols.push(`${sym} (ambiguous — try: ${flexResult.candidates.join(', ')})`);
          continue;
        }
        const pt = this.instrumentRegistry.getProviderToken(flexResult.uirId, providerName);
        if (pt != null) resolvedSymbolTokens.push(Number(pt));
        else unresolvedSymbols.push(sym);
      }
    }

    const totalInputCount = vortexPairs.length + numericInstruments.length;

    if (totalInputCount === 0 && symbols.length === 0) {
      this.sendError(
        client,
        'WS_INVALID_INSTRUMENTS',
        'Provide instruments (numeric tokens, Vortex EXCHANGE-TOKEN strings, or canonical symbols)',
      );
      return;
    }

    if (totalInputCount === 0 && resolvedSymbolTokens.length === 0) {
      this.sendError(
        client,
        'WS_INVALID_INSTRUMENTS',
        `No resolvable instruments found. Unresolved symbols: ${unresolvedSymbols.join(', ')}`,
      );
      return;
    }

    if (!['ltp', 'ohlcv', 'full'].includes(mode)) {
      this.sendError(
        client,
        'WS_INVALID_MODE',
        'Invalid mode. Must be ltp, ohlcv, or full',
      );
      return;
    }

    try {
      // Ensure streaming is active; auto-start on first subscriber if needed
      const status = await this.streamService.getStreamingStatus();
      if (!status?.isStreaming) {
        this.sendToClient(client, 'stream_starting', { message: 'Streaming not active — auto-starting provider ticker…', ts: Date.now() });
        const started = await this.streamService.autoStartIfNeeded();
        if (!started) {
          this.sendError(
            client,
            'WS_STREAM_UNAVAILABLE',
            'Could not auto-start streaming. Ensure provider credentials are configured (KITE_ACCESS_TOKEN / VORTEX_API_KEY).',
          );
          return;
        }
      }
    } catch (e) {
      this.logger.warn('Failed to read/auto-start streaming status', e as any);
    }

    // Phase 3: resolve provider tokens to UIR IDs for internal tracking.
    const providerName = this.streamService.activeProviderName;
    const allInputTokens: number[] = [
      ...numericInstruments,
      ...vortexPairs.map((p) => p.token),
      ...resolvedSymbolTokens,
    ];
    const uirIds: number[] = [];

    // Vortex EXCHANGE-TOKEN pairs: try full key "NSE_EQ-213123" first (primary registry key),
    // then fall back to numeric secondary key added during warmMaps().
    for (const p of vortexPairs) {
      const fullKey = `${p.exchange}-${p.token}`;
      const uirId =
        this.instrumentRegistry.resolveProviderToken('vortex', fullKey) ??
        this.instrumentRegistry.resolveProviderToken(providerName, p.token);
      uirIds.push(uirId != null ? uirId : p.token);
    }
    // Numeric tokens and symbol-resolved tokens — straightforward provider lookup.
    for (const token of [...numericInstruments, ...resolvedSymbolTokens]) {
      const uirId = this.instrumentRegistry.resolveProviderToken(providerName, token);
      uirIds.push(uirId != null ? uirId : token);
    }

    const prior = new Set(subscription.instruments);
    // Update subscription with UIR IDs
    subscription.instruments = [
      ...new Set([...subscription.instruments, ...uirIds]),
    ];
    uirIds.forEach((id: number) => {
      subscription.modeByInstrument.set(id, mode);
    });
    for (const id of uirIds) {
      if (!prior.has(id)) {
        this.wsInterest.addInterest(id);
      }
    }

    this.logger.debug(
      `[NativeWsService] Subscribing client ${clientId} count=${allInputTokens.length} uirIds=${uirIds.length} mode=${mode}`,
    );
    await this.subscribeToInstruments(uirIds, mode, clientId);

    let limits: Record<string, unknown> = {
      maxUpstreamInstruments: 1000,
      maxSubscriptionsPerSocket: 1000,
    };
    try {
      const provider = await this.providerResolver.resolveForWebsocket();
      const lim = (provider as any)?.getSubscriptionLimit?.();
      if (Number.isFinite(lim) && lim > 0) {
        limits.maxUpstreamInstruments = lim;
      }
      const v = (provider as any)?.getVortexWsLimits?.() ?? null;
      if (v) {
        limits.maxSubscriptionsPerSocket = v.perSocket;
        limits.maxVortexShards = v.maxShards;
        limits.maxVortexInstruments = v.total;
      }
    } catch {
      /* ignore */
    }

    // Send confirmation
    this.sendToClient(client, 'subscription_confirmed', {
      instruments: subscription.instruments,
      mode,
      limits,
      ...(unresolvedSymbols.length > 0 ? { unresolvedSymbols } : {}),
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Client ${clientId} subscribed to ${allInputTokens.length} instruments with mode=${mode}; confirmation sent`,
    );
  }

  private async handleUnsubscribe(client: HeartbeatWebSocket, data: any) {
    const clientId = client.clientId || 'unknown';
    const subscription = this.clientSubscriptions.get(clientId);

    if (!subscription) {
      this.sendError(
        client,
        'WS_SUBSCRIPTION_NOT_FOUND',
        'Client subscription not found',
      );
      return;
    }

    const { instruments } = data || {};
    if (!Array.isArray(instruments) || instruments.length === 0) {
      this.sendError(client, 'WS_INVALID_INSTRUMENTS', 'Invalid instruments');
      return;
    }

    // Phase 3: resolve incoming provider tokens to UIR IDs
    const providerName = this.streamService.activeProviderName;
    const requestedUirIds: number[] = [];
    for (const token of instruments as number[]) {
      const uirId = this.instrumentRegistry.resolveProviderToken(providerName, token);
      requestedUirIds.push(uirId != null ? uirId : token);
    }

    const before = new Set(subscription.instruments);
    // Remove UIR IDs from subscription
    subscription.instruments = subscription.instruments.filter(
      (id) => !requestedUirIds.includes(id),
    );

    const removed = Array.from(before).filter(
      (t) => !subscription.instruments.includes(t),
    );
    removed.forEach((id) => this.wsInterest.removeInterest(id));

    // Check if still subscribed globally
    const stillSubscribed = Array.from(this.clientSubscriptions.values()).some(
      (sub) => sub.instruments.some((id) => requestedUirIds.includes(id)),
    );

    if (!stillSubscribed) {
      await this.unsubscribeFromInstruments(requestedUirIds, clientId);
    }

    this.sendToClient(client, 'unsubscription_confirmed', {
      instruments: subscription.instruments,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Client ${clientId} unsubscribed from ${instruments.length} instruments`,
    );
  }

  private async handleSetMode(client: HeartbeatWebSocket, data: any) {
    const clientId = client.clientId || 'unknown';
    const subscription = this.clientSubscriptions.get(clientId);
    if (!subscription) {
      this.sendError(
        client,
        'WS_SUBSCRIPTION_NOT_FOUND',
        'Client subscription not found',
      );
      return;
    }
    const val = validateSetModePayload(data);
    if (!val.ok) {
      this.sendError(client, 'WS_INVALID_PAYLOAD', 'Invalid set_mode payload');
      return;
    }
    const { instruments, mode } = data as {
      instruments: Array<number | string>;
      mode: 'ltp' | 'ohlcv' | 'full';
    };
    const tokens: number[] = [];
    for (const item of instruments as any[]) {
      if (typeof item === 'string' && /-\d+$/.test(item)) {
        const tok = Number(String(item).split('-').pop());
        if (Number.isFinite(tok)) tokens.push(tok);
      } else {
        const n = Number(item);
        if (Number.isFinite(n)) tokens.push(n);
      }
    }
    // Phase 3: resolve provider tokens to UIR IDs
    const providerName = this.streamService.activeProviderName;
    const uirIds: number[] = [];
    for (const token of tokens) {
      const uirId = this.instrumentRegistry.resolveProviderToken(providerName, token);
      uirIds.push(uirId != null ? uirId : token);
    }
    const subscribedSet = new Set(subscription.instruments);
    const target = uirIds.filter((id) => subscribedSet.has(id));
    if (target.length > 0) {
      await this.streamService.setMode(mode, target);
      target.forEach((id) => subscription.modeByInstrument.set(id, mode));
    }
    this.sendToClient(client, 'mode_set', {
      requested: tokens,
      updated: target,
      mode,
      timestamp: new Date().toISOString(),
    });
  }

  private async handleGetQuote(client: HeartbeatWebSocket, data: any) {
    try {
      const { instruments, ltp_only } = data || {};

      if (!instruments || !Array.isArray(instruments) || instruments.length === 0) {
        this.sendError(
          client,
          'WS_INVALID_INSTRUMENTS',
          'Invalid instruments array',
        );
        return;
      }

      // Check cache
      const cachedQuote = await this.redisService.getCachedQuote(
        instruments.map((token: number) => token.toString()),
      );

      if (cachedQuote) {
        this.sendToClient(client, 'quote_data', {
          data: cachedQuote,
          cached: true,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Fetch from provider
      const provider = await this.providerResolver.resolveForWebsocket();
      let quotes = await provider.getQuote(
        instruments.map((token: number) => token.toString()),
      );

      // Optional: filter only tokens with valid last_price
      if (ltp_only && quotes && typeof quotes === 'object') {
        const filtered: Record<string, any> = {};
        Object.entries(quotes).forEach(([k, v]: any) => {
          const lp = (v as any)?.last_price;
          if (Number.isFinite(lp) && (lp as any) > 0) filtered[k] = v;
        });
        quotes = filtered;
      }

      // Cache result
      await this.redisService.cacheQuote(
        instruments.map((token: number) => token.toString()),
        quotes,
        30,
      );

      this.sendToClient(client, 'quote_data', {
        data: quotes,
        cached: false,
        timestamp: new Date().toISOString(),
        ltp_only: !!ltp_only,
      });
    } catch (error) {
      this.logger.error('Error fetching quotes', error as any);
      this.sendError(client, 'WS_QUOTE_ERROR', 'Failed to fetch quotes');
    }
  }

  private async handleGetHistoricalData(client: HeartbeatWebSocket, data: any) {
    try {
      const { instrumentToken, fromDate, toDate, interval } = data || {};

      const provider = await this.providerResolver.resolveForWebsocket();
      const historicalData = await provider.getHistoricalData(
        instrumentToken,
        fromDate,
        toDate,
        interval,
      );

      this.sendToClient(client, 'historical_data', {
        instrumentToken,
        data: historicalData,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error fetching historical data', error as any);
      this.sendError(
        client,
        'WS_HISTORICAL_ERROR',
        'Failed to fetch historical data',
      );
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
        this.logger.warn('subscribeToInstruments ignored: streaming not active');
        return;
      }
      await this.streamService.subscribeToInstruments(instruments, mode, clientId);
      this.logger.log(
        `[NativeWS] Queued subscription for ${instruments.length} instruments with mode=${mode} for client=${clientId}`,
      );
    } catch (error) {
      this.logger.error('Error queuing instrument subscriptions', error as any);
    }
  }

  private async unsubscribeFromInstruments(
    instruments: number[],
    clientId?: string,
  ) {
    try {
      const status = await this.streamService.getStreamingStatus();
      if (!status?.isStreaming) {
        this.logger.warn('unsubscribeFromInstruments ignored: streaming not active');
        return;
      }
      await this.streamService.unsubscribeFromInstruments(instruments, clientId);
      this.logger.log(
        `[NativeWS] Queued unsubscription for ${instruments.length} instruments for client=${clientId}`,
      );
    } catch (error) {
      this.logger.error('Error queuing instrument unsubscriptions', error as any);
    }
  }

  /**
   * Broadcast market data to native WebSocket clients.
   * @param identifier UIR ID (Phase 3 primary) — matches client subscription identifiers.
   */
  async broadcastMarketData(
    identifier: number,
    data: any,
    emitOpts?: MarketTickEmitOptions,
  ) {
    try {
      if (!this.server) {
        this.logger.warn('broadcastMarketData called before WS server init');
        return;
      }

      const subscribedClients = Array.from(this.clientSubscriptions.values()).filter(
        (sub) => sub.instruments.includes(identifier),
      );

      if (subscribedClients.length > 0) {
        // Broadcast to all clients in this service
        this.server.clients.forEach((client) => {
          const ws = client as HeartbeatWebSocket;
          if (ws.readyState === WebSocket.OPEN) {
            const clientId = ws.clientId;
            const subscription = clientId
              ? this.clientSubscriptions.get(clientId)
              : undefined;

            if (subscription && subscription.instruments.includes(identifier)) {
              const m: StreamTickMode =
                subscription.modeByInstrument.get(identifier) || 'ltp';
              const payload = shapeMarketTickForMode(data, m);
              this.sendToClient(ws, 'market_data', {
                instrumentToken: data?.instrument_token ?? identifier,
                uirId: identifier,
                data: payload,
                timestamp: new Date().toISOString(),
                ...(emitOpts?.syntheticLast ? { syntheticLast: true } : {}),
              });
            }
          }
        });

        this.logger.debug(
          `[NativeWS] Broadcasted tick UIR ${identifier} to ${subscribedClients.length} clients`,
        );
      }
    } catch (error) {
      this.logger.error('[NativeWS] Error broadcasting market data', error as any);
    }
  }

  private sendToClient(client: HeartbeatWebSocket, event: string, data: any) {
    try {
      if (client.readyState !== WebSocket.OPEN) return;
      // Backpressure guard (~16MB)
      if ((client as any).bufferedAmount && (client as any).bufferedAmount > 16 * 1024 * 1024) {
        this.logger.warn('Skipping send due to backpressure (bufferedAmount too high)');
        return;
      }
      client.send(JSON.stringify({ event, ...data }));
    } catch (e) {
      this.logger.warn('Failed to send frame to client', e as any);
    }
  }

  private sendError(client: HeartbeatWebSocket, code: string, message: string) {
    this.sendToClient(client, 'error', { code, message });
  }

  getConnectionStats() {
    return {
      totalConnections: this.clientSubscriptions.size,
      subscriptions: Array.from(this.clientSubscriptions.values()).map((sub) => ({
        userId: sub.userId,
        instrumentCount: sub.instruments.length,
        subscriptionType: sub.subscriptionType,
      })),
    };
  }
}


