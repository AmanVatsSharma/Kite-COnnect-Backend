/**
 * Native WebSocket Gateway
 *
 * Provides native WebSocket support (non-Socket.IO) for clients that prefer
 * the standard WebSocket API without Socket.IO overhead.
 *
 * Endpoint: /ws
 * Protocol: Native WebSocket (ws:// or wss://)
 * Authentication: Query parameter ?api_key=YOUR_KEY
 *
 * Message Format:
 * - Client → Server: { "event": "subscribe", "data": {...} }
 * - Server → Client: { "event": "market_data", "data": {...} }
 */

import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
import { Logger, Inject, forwardRef } from '@nestjs/common';
import { RedisService } from '../services/redis.service';
import { MarketDataProviderResolverService } from '../services/market-data-provider-resolver.service';
import { ApiKeyService } from '../services/api-key.service';
import { MarketDataStreamService } from '../services/market-data-stream.service';

interface ClientSubscription {
  clientId: string;
  userId: string;
  instruments: number[];
  subscriptionType: 'live' | 'historical' | 'both';
  modeByInstrument: Map<number, 'ltp' | 'ohlcv' | 'full'>;
}

interface WebSocketWithData extends WebSocket {
  apiKey?: string;
  clientId?: string;
}

@WebSocketGateway({
  path: '/ws',
  cors: {
    origin: '*',
  },
})
export class NativeWebSocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NativeWebSocketGateway.name);
  private clientSubscriptions = new Map<string, ClientSubscription>();

  constructor(
    private redisService: RedisService,
    private providerResolver: MarketDataProviderResolverService,
    private apiKeyService: ApiKeyService,
    @Inject(forwardRef(() => MarketDataStreamService))
    private streamService: MarketDataStreamService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('Native WebSocket Gateway initialized on /ws');
  }

  async handleConnection(client: WebSocketWithData, request: any) {
    const clientId = `native-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
    } catch (err) {
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

  async handleDisconnect(client: WebSocketWithData) {
    const clientId = client.clientId || 'unknown';
    this.logger.log(`Native WebSocket client disconnected: ${clientId}`);

    const subscription = this.clientSubscriptions.get(clientId);
    if (subscription) {
      // Unsubscribe from instruments
      if (subscription.instruments.length > 0) {
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

  private handleMessage(client: WebSocketWithData, message: string) {
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
      this.logger.error('Error parsing message', error);
      this.sendError(
        client,
        'WS_INVALID_MESSAGE',
        'Invalid JSON message format',
      );
    }
  }

  private async handleSubscribe(client: WebSocketWithData, data: any) {
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

    const { instruments, mode = 'ltp' } = data;

    if (
      !instruments ||
      !Array.isArray(instruments) ||
      instruments.length === 0
    ) {
      this.sendError(
        client,
        'WS_INVALID_INSTRUMENTS',
        'Invalid instruments array',
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
      // Check streaming status
      const status = await this.streamService.getStreamingStatus();
      if (!status?.isStreaming) {
        this.sendError(
          client,
          'WS_STREAM_INACTIVE',
          'Streaming is not active. Ask admin to start stream.',
        );
        return;
      }
    } catch (e) {
      this.logger.warn('Failed to read streaming status', e as any);
    }

    // Update subscription
    subscription.instruments = [
      ...new Set([...subscription.instruments, ...instruments]),
    ];
    instruments.forEach((token) => {
      subscription.modeByInstrument.set(token, mode);
    });

    // Subscribe to streaming service
    console.log(
      `[NativeWebSocketGateway] Subscribing client ${clientId} to ${instruments.length} instruments: ${JSON.stringify(instruments)} with mode=${mode}`,
    );
    await this.subscribeToInstruments(instruments, mode, clientId);

    // Send confirmation
    this.sendToClient(client, 'subscription_confirmed', {
      instruments: subscription.instruments,
      mode,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Client ${clientId} subscribed to ${instruments.length} instruments with mode=${mode}`,
    );
    console.log(
      `[NativeWebSocketGateway] Subscription confirmed sent to client ${clientId} for ${instruments.length} instruments`,
    );
  }

  private async handleUnsubscribe(client: WebSocketWithData, data: any) {
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

    const { instruments } = data;

    // Remove instruments
    subscription.instruments = subscription.instruments.filter(
      (token) => !instruments.includes(token),
    );

    // Check if still subscribed
    const stillSubscribed = Array.from(this.clientSubscriptions.values()).some(
      (sub) => sub.instruments.some((token) => instruments.includes(token)),
    );

    if (!stillSubscribed) {
      await this.unsubscribeFromInstruments(instruments, clientId);
    }

    this.sendToClient(client, 'unsubscription_confirmed', {
      instruments: subscription.instruments,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Client ${clientId} unsubscribed from ${instruments.length} instruments`,
    );
  }

  private async handleGetQuote(client: WebSocketWithData, data: any) {
    try {
      const { instruments, ltp_only } = data;

      if (
        !instruments ||
        !Array.isArray(instruments) ||
        instruments.length === 0
      ) {
        this.sendError(
          client,
          'WS_INVALID_INSTRUMENTS',
          'Invalid instruments array',
        );
        return;
      }

      // Check cache
      const cachedQuote = await this.redisService.getCachedQuote(
        instruments.map((token) => token.toString()),
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

      // Cache result
      await this.redisService.cacheQuote(
        instruments.map((token) => token.toString()),
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
      this.logger.error('Error fetching quotes', error);
      this.sendError(client, 'WS_QUOTE_ERROR', 'Failed to fetch quotes');
    }
  }

  private async handleGetHistoricalData(client: WebSocketWithData, data: any) {
    try {
      const { instrumentToken, fromDate, toDate, interval } = data;

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
      this.logger.error('Error fetching historical data', error);
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
        `[NativeWS Gateway] Queued subscription for ${instruments.length} instruments with mode=${mode} for client=${clientId}`,
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
        `[NativeWS Gateway] Queued unsubscription for ${instruments.length} instruments for client=${clientId}`,
      );
    } catch (error) {
      this.logger.error('Error queuing instrument unsubscriptions', error);
    }
  }

  // Broadcast market data to native WebSocket clients
  async broadcastMarketData(instrumentToken: number, data: any) {
    try {
      const subscribedClients = Array.from(
        this.clientSubscriptions.values(),
      ).filter((sub) => sub.instruments.includes(instrumentToken));

      if (subscribedClients.length > 0) {
        const message = {
          event: 'market_data',
          data: {
            instrumentToken,
            data,
            timestamp: new Date().toISOString(),
          },
        };

        // Broadcast to all clients in this gateway
        this.server.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            const clientId = (client as any).clientId;
            const subscription = this.clientSubscriptions.get(clientId);

            if (
              subscription &&
              subscription.instruments.includes(instrumentToken)
            ) {
              this.sendToClient(client as WebSocketWithData, 'market_data', {
                instrumentToken,
                data,
                timestamp: new Date().toISOString(),
              });
            }
          }
        });

        this.logger.log(
          `[NativeWS Gateway] Broadcasted tick ${instrumentToken} to ${subscribedClients.length} clients`,
        );
      }
    } catch (error) {
      this.logger.error(
        '[NativeWS Gateway] Error broadcasting market data',
        error,
      );
    }
  }

  private sendToClient(client: WebSocketWithData, event: string, data: any) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event, ...data }));
    }
  }

  private sendError(client: WebSocketWithData, code: string, message: string) {
    this.sendToClient(client, 'error', { code, message });
  }

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
