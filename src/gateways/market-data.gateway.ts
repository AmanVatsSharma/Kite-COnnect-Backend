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
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { Logger } from '@nestjs/common';
import { RedisService } from '../services/redis.service';
import { MarketDataProviderResolverService } from '../services/market-data-provider-resolver.service';
import { ApiKeyService } from '../services/api-key.service';
import { MarketDataStreamService } from '../services/market-data-stream.service';
import { Inject, forwardRef } from '@nestjs/common';
import { validateSubscribePayload, validateUnsubscribePayload } from '../utils/ws-validation';

const PROTOCOL_VERSION = '2.0';

/**
 * Client subscription tracking
 */
interface ClientSubscription {
  socketId: string;
  userId: string;
  instruments: number[];
  subscriptionType: 'live' | 'historical' | 'both';
  modeByInstrument: Map<number, 'ltp' | 'ohlcv' | 'full'>;
}

@WebSocketGateway({
  cors: {
    origin: '*', // Allow all origins for SaaS (can be restricted via CORS_ORIGIN env var)
  },
  namespace: '/market-data', // Socket.IO namespace
})
export class MarketDataGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MarketDataGateway.name);
  private clientSubscriptions = new Map<string, ClientSubscription>();

  constructor(
    private redisService: RedisService,
    private providerResolver: MarketDataProviderResolverService,
    private apiKeyService: ApiKeyService,
    @Inject(forwardRef(() => MarketDataStreamService))
    private streamService: MarketDataStreamService,
  ) {}

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

    try {
      // Attach Redis adapter lazily on first connection
      if (!(this.server as any)._redisAdapterAttached) {
        const pubClient = createClient({
          url: `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`,
          socket: { family: 4 }, // Force IPv4 to avoid ::1 issues
        });
        const subClient = pubClient.duplicate();
        await Promise.all([pubClient.connect(), subClient.connect()]);
        this.server.adapter(createAdapter(pubClient, subClient));
        (this.server as any)._redisAdapterAttached = true;
        this.logger.log('Socket.IO Redis adapter attached');
      }
    } catch (e) {
      this.logger.error('Failed to attach Socket.IO Redis adapter', e);
    }

    // API key validation and connection limit enforcement
    try {
      const headerKey = (client.handshake.headers['x-api-key'] as string) || '';
      const queryKey = (client.handshake.query['api_key'] as string) || '';
      const apiKey = headerKey || queryKey;
      if (!apiKey) {
        client.emit('error', { code: 'missing_api_key', message: 'Missing x-api-key' });
        client.disconnect(true);
        return;
      }
      const record = await this.apiKeyService.validateApiKey(apiKey);
      if (!record) {
        client.emit('error', { code: 'invalid_api_key', message: 'Invalid API key' });
        client.disconnect(true);
        return;
      }
      await this.apiKeyService.trackWsConnection(
        apiKey,
        record.connection_limit,
      );
      (client.data as any).apiKey = apiKey;
      (client.data as any).apiKeyRecord = record;
    } catch (err) {
      this.logger.warn(
        `Connection rejected for ${client.id}: ${err?.message || err}`,
      );
      client.disconnect(true);
      return;
    }

    // Initialize client subscription with connection limits per API key (if provided)
    this.clientSubscriptions.set(client.id, {
      socketId: client.id,
      userId: (client.handshake.query.userId as string) || 'anonymous',
      instruments: [],
      subscriptionType: 'live',
      modeByInstrument: new Map(),
    });

    // Send connection confirmation
    client.emit('connected', {
      message: 'Connected to market data stream',
      clientId: client.id,
      timestamp: new Date().toISOString(),
    });

    // Emit a branded welcome + onboarding payload for client UX
    try {
      const apiKey: string = (client.data as any)?.apiKey;
      const record: any = (client.data as any)?.apiKeyRecord;
      const limits = {
        connection: record?.connection_limit || 3,
        maxSubscriptionsPerSocket: 1000,
      } as any;
      try {
        const provider = await this.providerResolver.resolveForWebsocket();
        const lim = (provider as any)?.getSubscriptionLimit?.();
        if (Number.isFinite(lim) && lim > 0) {
          limits.maxSubscriptionsPerSocket = lim;
        }
      } catch {}
      const exchanges =
        (Array.isArray(record?.metadata?.exchanges) &&
          record?.metadata?.exchanges) || [
          'NSE_EQ',
          'NSE_FO',
          'NSE_CUR',
          'MCX_FO',
        ];
      const usage = await this.apiKeyService.getUsageReport(apiKey);
      const instructions = {
        subscribe:
          "socket.emit('subscribe', { instruments: [26000, 'NSE_FO-135938'], mode: 'ltp' })",
      };
      client.emit('welcome', {
        protocol_version: PROTOCOL_VERSION,
        message: 'Welcome to Vedpragya MarketData Solutions',
        provider: 'Vayu',
        exchanges,
        limits,
        instructions,
        apiKey: {
          tenant: (client.data as any)?.apiKeyRecord?.tenant_id || 'unknown',
          currentWsConnections: usage?.currentWsConnections || 0,
          httpRequestsThisMinute: usage?.httpRequestsThisMinute || 0,
          note:
            'Your API key is enabled for Vayu provider. Exchanges reflect entitlements.',
        },
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      this.logger.warn('Failed to emit welcome payload', e as any);
    }
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    const subscription = this.clientSubscriptions.get(client.id);
    if (subscription) {
      // Unsubscribe from instruments if any
      if (subscription.instruments.length > 0) {
        await this.unsubscribeFromInstruments(subscription.instruments);
      }

      this.clientSubscriptions.delete(client.id);
    }

    // Untrack WS connection for API key
    try {
      const apiKey = (client.data as any)?.apiKey;
      if (apiKey) {
        await this.apiKeyService.untrackWsConnection(apiKey);
      }
    } catch (e) {
      this.logger.warn(`Failed to untrack ws connection for ${client.id}`);
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
      instruments: number[];
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
      instruments: number[];
      type?: 'live' | 'historical' | 'both';
      mode?: 'ltp' | 'ohlcv' | 'full';
    },
    client: Socket,
  ) {
    try {
      const { instruments, type = 'live', mode = 'ltp' } = data;

      // Validate payload shape
      const v = validateSubscribePayload({ instruments, mode });
      if (!v.ok) {
        client.emit('error', {
          code: 'invalid_payload',
          message: 'Invalid subscribe payload',
          errors: v.errors,
        });
        return;
      }

      // Rate limit per event
      try {
        const limit = Number(process.env.WS_SUBSCRIBE_RPS || 10);
        const rl = await this.apiKeyService.checkWsRateLimit(
          client.id,
          'subscribe',
          limit,
        );
        if (rl) {
          client.emit('error', { code: 'rate_limited', message: 'Subscribe rate limit exceeded', ...rl });
          return;
        }
      } catch {}

      if (
        !instruments ||
        !Array.isArray(instruments) ||
        instruments.length === 0
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

      const subscription = this.clientSubscriptions.get(client.id);
      if (!subscription) {
        client.emit('error', { message: 'Client subscription not found' });
        return;
      }

      // Ensure streaming is active before delegating
      try {
        const status = await this.streamService.getStreamingStatus();
        if (!status?.isStreaming) {
          client.emit('error', {
            code: 'stream_inactive',
            message:
              'Streaming is not active. Ask admin to set provider and start stream: POST /api/admin/provider/global, then /api/admin/provider/stream/start',
          });
          return;
        }
      } catch (e) {
        this.logger.warn('Failed to read streaming status', e as any);
      }

      // Parse instruments allowing both numeric tokens and EXCHANGE-TOKEN strings
      const requestedRaw = Array.from(new Set(instruments as any));
      const explicitPairs: Array<{ token: number; exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO' }> = [];
      const numericTokens: number[] = [];

      for (const item of requestedRaw as any[]) {
        if (typeof item === 'string') {
          const s = String(item).trim().toUpperCase();
          const m = s.match(/^([A-Z_]+)-(\d+)$/);
          if (m) {
            const ex = m[1] as any;
            const tok = Number(m[2]);
            if (['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO'].includes(ex) && Number.isFinite(tok)) {
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
        this.logger.warn('Exchange resolution failed for tokens; proceeding with explicit pairs only', e as any);
      }

      // Merge explicit pairs and resolved pairs; explicit wins on conflicts
      const pairByToken = new Map<number, any>();
      for (const p of resolvedPairs) pairByToken.set(p.token, p.exchange);
      for (const p of explicitPairs) pairByToken.set(p.token, p.exchange);

      let finalPairs: Array<{ token: number; exchange: any }> = Array.from(
        pairByToken.entries(),
      ).map(([token, exchange]) => ({ token, exchange }));

      const unresolved = numericTokens.filter((t) => !pairByToken.has(t));

      // Entitlement enforcement: filter pairs by allowed exchanges from API key metadata
      const record: any = (client.data as any)?.apiKeyRecord;
      const allowed = new Set(
        (Array.isArray(record?.metadata?.exchanges) && record?.metadata?.exchanges) || [
          'NSE_EQ',
          'NSE_FO',
          'NSE_CUR',
          'MCX_FO',
        ],
      );
      const forbiddenPairs = finalPairs.filter((p) => !allowed.has(String(p.exchange)));
      finalPairs = finalPairs.filter((p) => allowed.has(String(p.exchange)));

      // Update subscription tracking only with included tokens
      const includedTokens = finalPairs.map((p) => p.token);
      subscription.instruments = [
        ...new Set([...subscription.instruments, ...includedTokens]),
      ];
      subscription.subscriptionType = type;
      includedTokens.forEach((token) => {
        subscription.modeByInstrument.set(token, mode);
      });

      // Delegate to stream service via pairs to prime mapping first
      if (finalPairs.length > 0) {
        console.log(
          `[MarketDataGateway] Subscribing client ${client.id} with ${finalPairs.length} pairs (mode=${mode})`,
        );
        await (this.streamService as any).subscribePairs?.(
          finalPairs,
          mode,
          client.id,
        );
      }

      // Join rooms only for included tokens
      includedTokens.forEach((token) => {
        client.join(`instrument:${token}`);
        console.log(
          `[MarketDataGateway] Client ${client.id} joined room for instrument:${token}`,
        );
      });

      // Ack with details
      let maxSubs = 1000;
      try {
        const lim = (provider as any)?.getSubscriptionLimit?.();
        if (Number.isFinite(lim) && lim > 0) maxSubs = lim;
      } catch {}
      // Initial snapshot for included tokens
      let snapshot: Record<string, { last_price: number | null }> = {};
      try {
        if (includedTokens.length > 0) {
          snapshot = await this.streamService.getRecentLTP(
            includedTokens.map((t) => String(t)),
          );
        }
      } catch {}

      // Initial snapshot for included tokens
      let snapshot: Record<string, { last_price: number | null }> = {};
      try {
        if (includedTokens.length > 0) {
          snapshot = await this.streamService.getRecentLTP(
            includedTokens.map((t) => String(t)),
          );
        }
      } catch {}

      client.emit('subscription_confirmed', {
        requested: requestedRaw,
        pairs: finalPairs.map((p) => `${p.exchange}-${p.token}`),
        included: includedTokens,
        unresolved,
        forbidden: forbiddenPairs.map((p) => ({ token: p.token, exchange: p.exchange })),
        snapshot,
        mode,
        limits: { maxSubscriptionsPerSocket: maxSubs },
        timestamp: new Date().toISOString(),
      });

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
        `Client ${client.id} subscribed to ${includedTokens.length}/${requestedRaw.length} instruments with mode=${mode}`,
      );
      console.log(
        `[MarketDataGateway] Subscription confirmed sent to client ${client.id} (included=${includedTokens.length}, unresolved=${unresolved.length})`,
      );
    } catch (error) {
      this.logger.error('Error handling instrument subscription', error);
      client.emit('error', { code: 'subscribe_failed', message: 'Failed to subscribe to instruments' });
    }
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

      // Rate limit per event
      try {
        const limit = Number(process.env.WS_UNSUBSCRIBE_RPS || 10);
        const rl = await this.apiKeyService.checkWsRateLimit(
          client.id,
          'unsubscribe',
          limit,
        );
        if (rl) {
          client.emit('error', { code: 'rate_limited', message: 'Unsubscribe rate limit exceeded', ...rl });
          return;
        }
      } catch {}

      const subscription = this.clientSubscriptions.get(client.id);
      if (!subscription) {
        client.emit('error', { message: 'Client subscription not found' });
        return;
      }

      // Support numeric or EXCHANGE-TOKEN inputs
      const requestedRaw = Array.from(new Set(instruments as any));
      const requestedTokens: number[] = [];
      for (const item of requestedRaw as any[]) {
        if (typeof item === 'string' && /-\d+$/.test(item)) {
          const tok = Number(String(item).split('-').pop());
          if (Number.isFinite(tok)) requestedTokens.push(tok);
        } else {
          const n = Number(item);
          if (Number.isFinite(n)) requestedTokens.push(n);
        }
      }

      // Remove instruments from subscription
      const before = new Set(subscription.instruments);
      subscription.instruments = subscription.instruments.filter(
        (token) => !requestedTokens.includes(token),
      );

      // Check if any other clients are subscribed to these instruments
      const stillSubscribed = Array.from(
        this.clientSubscriptions.values(),
      ).some((sub) =>
        sub.instruments.some((token) => requestedTokens.includes(token)),
      );

      if (!stillSubscribed) {
        await this.unsubscribeFromInstruments(requestedTokens, client.id);
      }

      // Leave rooms
      requestedTokens.forEach((token) => client.leave(`instrument:${token}`));

      const removed = Array.from(before).filter((t) => !subscription.instruments.includes(t));
      const not_found = requestedTokens.filter((t) => !before.has(t));
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
      client.emit('error', { code: 'quote_failed', message: 'Failed to fetch quotes' });
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
      const exchanges =
        (Array.isArray(record?.metadata?.exchanges) &&
          record?.metadata?.exchanges) || [
          'NSE_EQ',
          'NSE_FO',
          'NSE_CUR',
          'MCX_FO',
        ];
      const limits = {
        connection: record?.connection_limit || 3,
        maxSubscriptionsPerSocket: 1000,
      } as any;
      try {
        const provider = await this.providerResolver.resolveForWebsocket();
        const lim = (provider as any)?.getSubscriptionLimit?.();
        if (Number.isFinite(lim) && lim > 0) limits.maxSubscriptionsPerSocket = lim;
      } catch {}

      const sub = this.clientSubscriptions.get(client.id);
      const tokens = sub?.instruments || [];
      const modes: Record<number, string> = {};
      sub?.modeByInstrument?.forEach((m, t) => (modes[t] = m));

      // Resolve pairs for better diagnostics
      let pairs: string[] = [];
      try {
        const provider = await this.providerResolver.resolveForWebsocket();
        const exMap: Map<string, any> = (provider as any)?.resolveExchanges
          ? await (provider as any).resolveExchanges(tokens.map((t) => String(t)))
          : new Map();
        pairs = tokens
          .filter((t) => exMap.has(String(t)))
          .map((t) => `${exMap.get(String(t))}-${t}`);
      } catch {}

      client.emit('whoami', {
        protocol_version: PROTOCOL_VERSION,
        provider: 'Vayu',
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
      client.emit('error', { code: 'whoami_failed', message: 'Failed to retrieve identity' });
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
      client.emit('error', { code: 'historical_failed', message: 'Failed to fetch historical data' });
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
    body: { instruments: Array<number | string>; mode: 'ltp' | 'ohlcv' | 'full' },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const { instruments, mode } = body as any;
      const subscription = this.clientSubscriptions.get(client.id);
      if (!subscription) {
        client.emit('error', { code: 'not_connected', message: 'No active subscription context' });
        return;
      }

      // Rate limit per event
      try {
        const limit = Number(process.env.WS_MODE_RPS || 20);
        const rl = await this.apiKeyService.checkWsRateLimit(
          client.id,
          'set_mode',
          limit,
        );
        if (rl) {
          client.emit('error', { code: 'rate_limited', message: 'Set mode rate limit exceeded', ...rl });
          return;
        }
      } catch {}

      // Validate
      const v = (await import('../utils/ws-validation')) as any;
      const val = v.validateSetModePayload({ instruments, mode });
      if (!val.ok) {
        client.emit('error', {
          code: 'invalid_payload',
          message: 'Invalid set_mode payload',
          errors: val.errors,
        });
        return;
      }

      // Parse targets
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

      const subscribedSet = new Set(subscription.instruments);
      const target = tokens.filter((t) => subscribedSet.has(t));
      const not_subscribed = tokens.filter((t) => !subscribedSet.has(t));

      if (target.length > 0) {
        await this.streamService.setMode(mode, target);
        target.forEach((t) => subscription.modeByInstrument.set(t, mode));
      }

      // Compute unresolved by attempting resolution (diagnostic only)
      let unresolved: number[] = [];
      try {
        const provider = await this.providerResolver.resolveForWebsocket();
        const exMap: Map<string, any> = (provider as any)?.resolveExchanges
          ? await (provider as any).resolveExchanges(target.map((t) => String(t)))
          : new Map();
        unresolved = target.filter((t) => !exMap.has(String(t)));
      } catch {}

      client.emit('mode_set', {
        requested: tokens,
        updated: target,
        not_subscribed,
        unresolved,
        mode,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      this.logger.error('Error handling set_mode', e);
      client.emit('error', { code: 'set_mode_failed', message: 'Failed to set mode' });
    }
  }

  /**
   * List current subscriptions for this client
   * Event: 'list_subscriptions'
   */
  @SubscribeMessage('list_subscriptions')
  async handleListSubscriptions(@ConnectedSocket() client: Socket) {
    try {
      const sub = this.clientSubscriptions.get(client.id);
      const tokens = sub?.instruments || [];
      const modes: Record<number, string> = {};
      sub?.modeByInstrument?.forEach((m, t) => (modes[t] = m));
      let pairs: string[] = [];
      try {
        const provider = await this.providerResolver.resolveForWebsocket();
        const exMap: Map<string, any> = (provider as any)?.resolveExchanges
          ? await (provider as any).resolveExchanges(tokens.map((t) => String(t)))
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
      client.emit('error', { code: 'list_failed', message: 'Failed to list subscriptions' });
    }
  }

  /**
   * Unsubscribe all tokens for this client
   * Event: 'unsubscribe_all'
   */
  @SubscribeMessage('unsubscribe_all')
  async handleUnsubscribeAll(@ConnectedSocket() client: Socket) {
    try {
      const sub = this.clientSubscriptions.get(client.id);
      const tokens = sub?.instruments || [];
      if (tokens.length > 0) {
        await this.unsubscribeFromInstruments(tokens, client.id);
        tokens.forEach((t) => client.leave(`instrument:${t}`));
      }
      if (sub) {
        sub.instruments = [];
        sub.modeByInstrument.clear();
      }
      client.emit('unsubscribed_all', {
        removed_count: tokens.length,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      this.logger.warn('unsubscribe_all failed', e as any);
      client.emit('error', { code: 'unsubscribe_all_failed', message: 'Failed to unsubscribe all' });
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
      const sub = this.clientSubscriptions.get(client.id);
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
      client.emit('error', { code: 'status_failed', message: 'Failed to get status' });
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
  async broadcastMarketData(instrumentToken: number, data: any) {
    try {
      const startTime = Date.now();
      const subscribedClients = Array.from(
        this.clientSubscriptions.values(),
      ).filter((sub) => sub.instruments.includes(instrumentToken));

      if (subscribedClients.length > 0) {
        const message = {
          instrumentToken,
          data,
          timestamp: new Date().toISOString(),
        };

        // Room-based broadcast
        this.server
          .to(`instrument:${instrumentToken}`)
          .emit('market_data', message);

        const broadcastTime = Date.now() - startTime;
        this.logger.log(
          `[Gateway] Broadcasted tick ${instrumentToken} to ${subscribedClients.length} clients in ${broadcastTime}ms`,
        );
      }
    } catch (error) {
      this.logger.error('[Gateway] Error broadcasting market data', error);
    }
  }

  // Method to get connection statistics
  getConnectionStats() {
    return {
      totalConnections: this.clientSubscriptions.size,
      subscriptions: Array.from(this.clientSubscriptions.values()).map(
        (sub) => ({
          userId: sub.userId,
          instrumentCount: sub.instruments.length,
          subscriptionType: sub.subscriptionType,
        }),
      ),
    };
  }
}
