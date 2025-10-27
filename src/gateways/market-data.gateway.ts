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

interface ClientSubscription {
  socketId: string;
  userId: string;
  instruments: number[];
  subscriptionType: 'live' | 'historical' | 'both';
  modeByInstrument: Map<number, 'ltp' | 'ohlcv' | 'full'>;
}

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  namespace: '/market-data',
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

  @SubscribeMessage('subscribe_instruments')
  async handleSubscribeInstruments(
    @MessageBody() data: { instruments: number[]; type?: 'live' | 'historical' | 'both'; mode?: 'ltp' | 'ohlcv' | 'full' },
    @ConnectedSocket() client: Socket,
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
      await this.subscribeToInstruments(instruments, mode, client.id);

      // Join instrument rooms for targeted broadcast
      instruments.forEach(token => client.join(`instrument:${token}`));

      // Send confirmation with mode information
      client.emit('subscription_confirmed', {
        instruments: subscription.instruments,
        type: subscription.subscriptionType,
        mode,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Client ${client.id} subscribed to ${instruments.length} instruments with mode=${mode}`);
    } catch (error) {
      this.logger.error('Error handling instrument subscription', error);
      client.emit('error', { message: 'Failed to subscribe to instruments' });
    }
  }

  @SubscribeMessage('unsubscribe_instruments')
  async handleUnsubscribeInstruments(
    @MessageBody() data: { instruments: number[] },
    @ConnectedSocket() client: Socket,
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

  @SubscribeMessage('get_quote')
  async handleGetQuote(
    @MessageBody() data: { instruments: number[] },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const { instruments } = data;
      
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
      const quotes = await provider.getQuote(
        instruments.map(token => token.toString())
      );

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
      });
    } catch (error) {
      this.logger.error('Error fetching quotes', error);
      client.emit('error', { message: 'Failed to fetch quotes' });
    }
  }

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

  // Method to broadcast market data to subscribed clients
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
