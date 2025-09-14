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
import { Logger } from '@nestjs/common';
import { RedisService } from '../services/redis.service';
import { KiteConnectService } from '../services/kite-connect.service';

interface ClientSubscription {
  socketId: string;
  userId: string;
  instruments: number[];
  subscriptionType: 'live' | 'historical' | 'both';
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
    private kiteConnectService: KiteConnectService,
  ) {}

  async handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    
    // Initialize client subscription
    this.clientSubscriptions.set(client.id, {
      socketId: client.id,
      userId: client.handshake.query.userId as string || 'anonymous',
      instruments: [],
      subscriptionType: 'live',
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
  }

  @SubscribeMessage('subscribe_instruments')
  async handleSubscribeInstruments(
    @MessageBody() data: { instruments: number[]; type?: 'live' | 'historical' | 'both' },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const { instruments, type = 'live' } = data;
      
      if (!instruments || !Array.isArray(instruments) || instruments.length === 0) {
        client.emit('error', { message: 'Invalid instruments array' });
        return;
      }

      const subscription = this.clientSubscriptions.get(client.id);
      if (!subscription) {
        client.emit('error', { message: 'Client subscription not found' });
        return;
      }

      // Update subscription
      subscription.instruments = [...new Set([...subscription.instruments, ...instruments])];
      subscription.subscriptionType = type;

      // Subscribe to Kite ticker if not already subscribed
      await this.subscribeToInstruments(instruments);

      // Send confirmation
      client.emit('subscription_confirmed', {
        instruments: subscription.instruments,
        type: subscription.subscriptionType,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Client ${client.id} subscribed to ${instruments.length} instruments`);
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
        await this.unsubscribeFromInstruments(instruments);
      }

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

      // Fetch from Kite API
      const quotes = await this.kiteConnectService.getQuote(
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

      const historicalData = await this.kiteConnectService.getHistoricalData(
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

  private async subscribeToInstruments(instruments: number[]) {
    try {
      const ticker = this.kiteConnectService.getTicker();
      if (ticker) {
        ticker.subscribe(instruments);
        this.logger.log(`Subscribed to ${instruments.length} instruments`);
      }
    } catch (error) {
      this.logger.error('Error subscribing to instruments', error);
    }
  }

  private async unsubscribeFromInstruments(instruments: number[]) {
    try {
      const ticker = this.kiteConnectService.getTicker();
      if (ticker) {
        ticker.unsubscribe(instruments);
        this.logger.log(`Unsubscribed from ${instruments.length} instruments`);
      }
    } catch (error) {
      this.logger.error('Error unsubscribing from instruments', error);
    }
  }

  // Method to broadcast market data to subscribed clients
  async broadcastMarketData(instrumentToken: number, data: any) {
    try {
      const subscribedClients = Array.from(this.clientSubscriptions.values())
        .filter(sub => sub.instruments.includes(instrumentToken));

      if (subscribedClients.length > 0) {
        const message = {
          instrumentToken,
          data,
          timestamp: new Date().toISOString(),
        };

        subscribedClients.forEach(subscription => {
          this.server.to(subscription.socketId).emit('market_data', message);
        });

        this.logger.log(`Broadcasted market data for instrument ${instrumentToken} to ${subscribedClients.length} clients`);
      }
    } catch (error) {
      this.logger.error('Error broadcasting market data', error);
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
