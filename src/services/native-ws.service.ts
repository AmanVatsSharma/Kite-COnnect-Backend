import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  OnModuleDestroy,
} from '@nestjs/common';
import { Server as WSServer, WebSocket } from 'ws';
import { RedisService } from './redis.service';
import { MarketDataProviderResolverService } from './market-data-provider-resolver.service';
import { ApiKeyService } from './api-key.service';
import { MarketDataStreamService } from './market-data-stream.service';

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

    this.server = new WSServer({ server: httpServer, path });
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
          // Console for easy later debugging
          // eslint-disable-next-line no-console
          console.error('[NativeWsService] Client error', err);
          this.logger.error('Client WS error', err as any);
        });
      } catch (e) {
        this.logger.error('Error during WS connection setup', e as any);
      }
    });

    this.server.on('error', (err) => {
      // Console for easy later debugging
      // eslint-disable-next-line no-console
      console.error('[NativeWsService] Server error', err);
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

    this.logger.log(`Native WebSocket server initialized on ${path}`);
    // Console for easy later debugging
    // eslint-disable-next-line no-console
    console.log(`[NativeWsService] WS listening on path ${path}`);
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
    // Console for easy later debugging
    // eslint-disable-next-line no-console
    console.log(`[NativeWsService] Client connected ${clientId}`);

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
    // Console for easy later debugging
    // eslint-disable-next-line no-console
    console.log(`[NativeWsService] Client disconnected ${clientId}`);

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

    const { instruments, mode = 'ltp' } = data || {};

    if (!instruments || !Array.isArray(instruments) || instruments.length === 0) {
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
    instruments.forEach((token: number) => {
      subscription.modeByInstrument.set(token, mode);
    });

    // Subscribe to streaming service
    // Console for easy later debugging
    // eslint-disable-next-line no-console
    console.log(
      `[NativeWsService] Subscribing client ${clientId} to ${instruments.length} instruments: ${JSON.stringify(
        instruments,
      )} with mode=${mode}`,
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
    // Console for easy later debugging
    // eslint-disable-next-line no-console
    console.log(
      `[NativeWsService] Subscription confirmed sent to client ${clientId} for ${instruments.length} instruments`,
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

    // Remove instruments
    subscription.instruments = subscription.instruments.filter(
      (token) => !instruments.includes(token),
    );

    // Check if still subscribed globally
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

  // Broadcast market data to native WebSocket clients
  async broadcastMarketData(instrumentToken: number, data: any) {
    try {
      if (!this.server) {
        this.logger.warn('broadcastMarketData called before WS server init');
        return;
      }

      const subscribedClients = Array.from(this.clientSubscriptions.values()).filter(
        (sub) => sub.instruments.includes(instrumentToken),
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

            if (subscription && subscription.instruments.includes(instrumentToken)) {
              this.sendToClient(ws, 'market_data', {
                instrumentToken,
                data,
                timestamp: new Date().toISOString(),
              });
            }
          }
        });

        this.logger.log(
          `[NativeWS] Broadcasted tick ${instrumentToken} to ${subscribedClients.length} clients`,
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


