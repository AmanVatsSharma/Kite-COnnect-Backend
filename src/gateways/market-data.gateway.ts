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
export class MarketDataGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MarketDataGateway.name);
  private clientSubscriptions = new Map<string, ClientSubscription>();

  constructor(
    private redisService: RedisService,
    private providerResolver: MarketDataProviderResolverService,
    private apiKeyService: ApiKeyService,
    @Inject(forwardRef(() => MarketDataStreamService)) private streamService: MarketDataStreamService,
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
          socket: { family: 4 } // Force IPv4 to avoid ::1 issues
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
        client.emit('error', { message: 'Missing x-api-key' });
        client.disconnect(true);
        return;
      }
      const record = await this.apiKeyService.validateApiKey(apiKey);
      if (!record) {
        client.emit('error', { message: 'Invalid API key' });
        client.disconnect(true);
        return;
      }
      await this.apiKeyService.trackWsConnection(apiKey, record.connection_limit);
      (client.data as any).apiKey = apiKey;
    } catch (err) {
      this.logger.warn(`Connection rejected for ${client.id}: ${err?.message || err}`);
      client.disconnect(true);
      return;
    }

    // Initialize client subscription with connection limits per API key (if provided)
    this.clientSubscriptions.set(client.id, {
      socketId: client.id,
      userId: client.handshake.query.userId as string || 'anonymous',
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
    @MessageBody() data: { instruments: number[]; type?: 'live' | 'historical' | 'both'; mode?: 'ltp' | 'ohlcv' | 'full' },
    @ConnectedSocket() client: Socket,
  ) {
    return this.doSubscribe(data, client);
  }

  // Deprecated event name - kept for backward compatibility
  @SubscribeMessage('subscribe_instruments')
  async handleSubscribeInstruments(
    @MessageBody() data: { instruments: number[]; type?: 'live' | 'historical' | 'both'; mode?: 'ltp' | 'ohlcv' | 'full' },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.warn(`Client ${client.id} used deprecated event 'subscribe_instruments'. Please use 'subscribe' instead.`);
    return this.doSubscribe(data, client);
  }

  // Internal handler
  private async doSubscribe(
    data: { instruments: number[]; type?: 'live' | 'historical' | 'both'; mode?: 'ltp' | 'ohlcv' | 'full' },
    client: Socket,
  ) {
    try {
      const { instruments, type = 'live', mode = 'ltp' } = data;
      
      if (!instruments || !Array.isArray(instruments) || instruments.length === 0) {
        client.emit('error', { message: 'Invalid instruments array' });
        return;
      }

      // Validate mode parameter
      if (!['ltp', 'ohlcv', 'full'].includes(mode)) {
        client.emit('error', { message: 'Invalid mode. Must be ltp, ohlcv, or full' });
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
          client.emit('error', { message: 'Streaming is not active. Ask admin to set provider and start stream: POST /api/admin/provider/global, then /api/admin/provider/stream/start' });
          return;
        }
      } catch (e) {
        this.logger.warn('Failed to read streaming status', e as any);
      }

      // Update subscription with mode tracking per instrument
      subscription.instruments = [...new Set([...subscription.instruments, ...instruments])];
      subscription.subscriptionType = type;
      
      // Store mode for each instrument
      instruments.forEach(token => {
        subscription.modeByInstrument.set(token, mode);
      });

      // Delegate subscription to streaming service with mode support and client tracking
      console.log(`[MarketDataGateway] Subscribing client ${client.id} to ${instruments.length} instruments: ${JSON.stringify(instruments)} with mode=${mode}`);
      await this.subscribeToInstruments(instruments, mode, client.id);

      // Join instrument rooms for targeted broadcast
      instruments.forEach(token => {
        client.join(`instrument:${token}`);
        console.log(`[MarketDataGateway] Client ${client.id} joined room for instrument:${token}`);
      });

      // Send confirmation with mode information
      client.emit('subscription_confirmed', {
        instruments: subscription.instruments,
        type: subscription.subscriptionType,
        mode,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Client ${client.id} subscribed to ${instruments.length} instruments with mode=${mode}`);
      console.log(`[MarketDataGateway] Subscription confirmed sent to client ${client.id} for ${instruments.length} instruments`);
    } catch (error) {
      this.logger.error('Error handling instrument subscription', error);
      client.emit('error', { message: 'Failed to subscribe to instruments' });
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
    this.logger.warn(`Client ${client.id} used deprecated event 'unsubscribe_instruments'. Please use 'unsubscribe' instead.`);
    return this.doUnsubscribe(data, client);
  }

  // Internal handler
  private async doUnsubscribe(
    data: { instruments: number[] },
    client: Socket,
  ) {
    try {
      const { instruments } = data;
      
      const subscription = this.clientSubscriptions.get(client.id);
      if (!subscription) {
        client.emit('error', { message: 'Client subscription not found' });
        return;
      }

      // Remove instruments from subscription
      subscription.instruments = subscription.instruments.filter(
        token => !instruments.includes(token)
      );

      // Check if any other clients are subscribed to these instruments
      const stillSubscribed = Array.from(this.clientSubscriptions.values())
        .some(sub => sub.instruments.some(token => instruments.includes(token)));

      if (!stillSubscribed) {
        await this.unsubscribeFromInstruments(instruments, client.id);
      }

      // Leave rooms
      instruments.forEach(token => client.leave(`instrument:${token}`));

      client.emit('unsubscription_confirmed', {
        instruments: subscription.instruments,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Client ${client.id} unsubscribed from ${instruments.length} instruments`);
    } catch (error) {
      this.logger.error('Error handling instrument unsubscription', error);
      client.emit('error', { message: 'Failed to unsubscribe from instruments' });
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
      
      if (!instruments || !Array.isArray(instruments) || instruments.length === 0) {
        client.emit('error', { message: 'Invalid instruments array' });
        return;
      }

      // Check cache first
      const cachedQuote = await this.redisService.getCachedQuote(
        instruments.map(token => token.toString())
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
        instruments.map(token => token.toString())
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
        instruments.map(token => token.toString()),
        quotes,
        30
      );

      client.emit('quote_data', {
        data: quotes,
        cached: false,
        timestamp: new Date().toISOString(),
        ltp_only: !!ltp_only,
      });
    } catch (error) {
      this.logger.error('Error fetching quotes', error);
      client.emit('error', { message: 'Failed to fetch quotes' });
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
    @MessageBody() data: {
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
        interval
      );

      client.emit('historical_data', {
        instrumentToken,
        data: historicalData,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error fetching historical data', error);
      client.emit('error', { message: 'Failed to fetch historical data' });
    }
  }

  private async subscribeToInstruments(instruments: number[], mode: 'ltp' | 'ohlcv' | 'full' = 'ltp', clientId?: string) {
    try {
      const status = await this.streamService.getStreamingStatus();
      if (!status?.isStreaming) {
        this.logger.warn('subscribeToInstruments ignored: streaming not active');
        return;
      }
      await this.streamService.subscribeToInstruments(instruments, mode, clientId);
      this.logger.log(`[Gateway] Queued subscription for ${instruments.length} instruments with mode=${mode} for client=${clientId}`);
    } catch (error) {
      this.logger.error('Error queuing instrument subscriptions', error);
    }
  }

  private async unsubscribeFromInstruments(instruments: number[], clientId?: string) {
    try {
      const status = await this.streamService.getStreamingStatus();
      if (!status?.isStreaming) {
        this.logger.warn('unsubscribeFromInstruments ignored: streaming not active');
        return;
      }
      await this.streamService.unsubscribeFromInstruments(instruments, clientId);
      this.logger.log(`[Gateway] Queued unsubscription for ${instruments.length} instruments for client=${clientId}`);
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
      const subscribedClients = Array.from(this.clientSubscriptions.values())
        .filter(sub => sub.instruments.includes(instrumentToken));

      if (subscribedClients.length > 0) {
        const message = {
          instrumentToken,
          data,
          timestamp: new Date().toISOString(),
        };

        // Room-based broadcast
        this.server.to(`instrument:${instrumentToken}`).emit('market_data', message);

        const broadcastTime = Date.now() - startTime;
        this.logger.log(`[Gateway] Broadcasted tick ${instrumentToken} to ${subscribedClients.length} clients in ${broadcastTime}ms`);
      }
    } catch (error) {
      this.logger.error('[Gateway] Error broadcasting market data', error);
    }
  }

  // Method to get connection statistics
  getConnectionStats() {
    return {
      totalConnections: this.clientSubscriptions.size,
      subscriptions: Array.from(this.clientSubscriptions.values()).map(sub => ({
        userId: sub.userId,
        instrumentCount: sub.instruments.length,
        subscriptionType: sub.subscriptionType,
      })),
    };
  }
}
