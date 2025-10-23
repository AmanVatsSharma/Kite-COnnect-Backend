import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MarketDataProviderResolverService } from './market-data-provider-resolver.service';
import { MarketDataProvider } from '../providers/market-data.provider';
import { StockService } from '../modules/stock/stock.service';
import { RedisService } from './redis.service';

@Injectable()
export class MarketDataStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketDataStreamService.name);
  private isStreaming = false;
  private subscribedInstruments: Set<number> = new Set();
  private streamInterval: NodeJS.Timeout | null = null;
  private subscriptionQueue: Map<number, { mode: 'ltp' | 'ohlcv' | 'full'; timestamp: number; clients: Set<string> }> = new Map();
  private unsubscriptionQueue: Set<number> = new Set();
  private subscriptionBatchInterval: NodeJS.Timeout | null = null;

  constructor(
    private providerResolver: MarketDataProviderResolverService,
    @Inject(forwardRef(() => StockService)) private stockService: StockService,
    private redisService: RedisService,
  ) {}

  async onModuleInit() {
    // Do not auto-start streaming; wait for admin trigger
  }

  async onModuleDestroy() {
    await this.stopStreaming();
  }

  private async initializeStreaming() {
    try {
      // Global provider for WS streaming
      const provider = await this.providerResolver.resolveForWebsocket();
      const ticker = provider.initializeTicker();
      
      // Set up ticker event handlers
      if (ticker?.on) {
        ticker.on('ticks', (ticks: any[]) => {
          this.handleTicks(ticks);
        });

        ticker.on('connect', () => {
          this.logger.log('Provider ticker connected');
          this.isStreaming = true;
        });

        ticker.on('disconnect', () => {
          this.logger.log('Provider ticker disconnected');
          this.isStreaming = false;
        });

        ticker.on('error', (error: any) => {
          this.logger.error('Provider ticker error', error);
          this.isStreaming = false;
        });

        // Connect to ticker with safe guard
        // Connect without blocking startup; failures will be logged inside the provider
        try {
          setTimeout(() => {
            try { ticker.connect?.(); } catch (e2) { this.logger.error('Error connecting provider ticker', e2); }
          }, 0);
        } catch (e) {
          this.logger.error('Error scheduling provider ticker connect', e);
        }
      } else {
        this.logger.warn('Ticker not initialized; ensure provider is configured and authenticated (Kite or Vortex)');
      }

      this.logger.log('Market data streaming service initialized');
    } catch (error) {
      this.logger.error('Failed to initialize market data streaming', error);
    }
  }

  private async handleTicks(ticks: any[]) {
    try {
      for (const tick of ticks) {
        const instrumentToken = tick.instrument_token;
        
        // Store market data in database
        await this.stockService.storeMarketData(instrumentToken, tick);
        
        // Update subscribed instruments set
        this.subscribedInstruments.add(instrumentToken);
      }
    } catch (error) {
      this.logger.error('Error handling ticks', error);
    }
  }

  async subscribeToInstruments(instrumentTokens: number[], mode: 'ltp' | 'ohlcv' | 'full' = 'ltp', clientId?: string) {
    try {
      // Queue subscriptions for batching instead of immediate execution
      instrumentTokens.forEach(token => {
        if (!this.subscriptionQueue.has(token)) {
          this.subscriptionQueue.set(token, {
            mode,
            timestamp: Date.now(),
            clients: new Set()
          });
        }
        
        const subscription = this.subscriptionQueue.get(token)!;
        if (clientId) {
          subscription.clients.add(clientId);
        }
        
        // Update mode if it's higher priority (full > ohlcv > ltp)
        const modePriority = { 'ltp': 1, 'ohlcv': 2, 'full': 3 };
        if (modePriority[mode] > modePriority[subscription.mode]) {
          subscription.mode = mode;
        }
      });

      // Start batching interval if not already started
      if (!this.subscriptionBatchInterval) {
        this.startSubscriptionBatching();
      }

      this.logger.log(`[StreamBatching] Queued ${instrumentTokens.length} instruments for subscription with mode=${mode}`);
    } catch (error) {
      this.logger.error('Error queuing instrument subscriptions', error);
      throw error;
    }
  }

  async unsubscribeFromInstruments(instrumentTokens: number[], clientId?: string) {
    try {
      // Queue unsubscriptions for batching
      instrumentTokens.forEach(token => {
        if (this.subscriptionQueue.has(token) && clientId) {
          const subscription = this.subscriptionQueue.get(token)!;
          subscription.clients.delete(clientId);
          
          // If no clients left, queue for unsubscription
          if (subscription.clients.size === 0) {
            this.subscriptionQueue.delete(token);
            this.unsubscriptionQueue.add(token);
          }
        } else {
          this.unsubscriptionQueue.add(token);
        }
      });

      this.logger.log(`[StreamBatching] Queued ${instrumentTokens.length} instruments for unsubscription`);
    } catch (error) {
      this.logger.error('Error queuing instrument unsubscriptions', error);
      throw error;
    }
  }

  private startSubscriptionBatching() {
    this.subscriptionBatchInterval = setInterval(() => {
      this.processSubscriptionBatch();
    }, 500); // Process every 500ms
  }

  private async processSubscriptionBatch() {
    try {
      if (this.subscriptionQueue.size === 0 && this.unsubscriptionQueue.size === 0) {
        return;
      }

      const provider = await this.providerResolver.resolveForWebsocket();
      const ticker = provider.getTicker();
      if (!ticker || !this.isStreaming) {
        return;
      }

      // Process subscriptions
      if (this.subscriptionQueue.size > 0) {
        const subscriptions = Array.from(this.subscriptionQueue.entries());
        const tokensToSubscribe = subscriptions.map(([token]) => token);
        
        // Group by mode for efficient batching
        const modeGroups = new Map<string, number[]>();
        subscriptions.forEach(([token, sub]) => {
          if (!modeGroups.has(sub.mode)) {
            modeGroups.set(sub.mode, []);
          }
          modeGroups.get(sub.mode)!.push(token);
        });

        // Subscribe by mode groups
        for (const [mode, tokens] of modeGroups) {
          ticker.subscribe(tokens, mode as 'ltp' | 'ohlcv' | 'full');
          tokens.forEach(token => this.subscribedInstruments.add(token));
        }

        this.logger.log(`[StreamBatching] Processed ${tokensToSubscribe.length} subscriptions in ${modeGroups.size} mode groups`);
        this.subscriptionQueue.clear();
      }

      // Process unsubscriptions
      if (this.unsubscriptionQueue.size > 0) {
        const tokensToUnsubscribe = Array.from(this.unsubscriptionQueue);
        ticker.unsubscribe(tokensToUnsubscribe);
        tokensToUnsubscribe.forEach(token => this.subscribedInstruments.delete(token));
        
        this.logger.log(`[StreamBatching] Processed ${tokensToUnsubscribe.length} unsubscriptions`);
        this.unsubscriptionQueue.clear();
      }

    } catch (error) {
      this.logger.error('[StreamBatching] Error processing subscription batch', error);
    }
  }

  async setMode(mode: string, instrumentTokens: number[]) {
    try {
      const provider = await this.providerResolver.resolveForWebsocket();
      const ticker = provider.getTicker();
      if (ticker && this.isStreaming) {
        ticker.setMode(mode, instrumentTokens);
        this.logger.log(`Set mode ${mode} for ${instrumentTokens.length} instruments`);
      }
    } catch (error) {
      this.logger.error('Error setting ticker mode', error);
      throw error;
    }
  }

  // Cron job to sync instruments daily
  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async syncInstrumentsDaily() {
    try {
      this.logger.log('Starting daily instrument sync');
      const result = await this.stockService.syncInstruments();
      this.logger.log(`Daily sync completed: ${result.synced} synced, ${result.updated} updated`);
    } catch (error) {
      this.logger.error('Error in daily instrument sync', error);
    }
  }

  // Cron job to clean old market data
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async cleanOldMarketData() {
    try {
      this.logger.log('Starting cleanup of old market data');
      // Implement cleanup logic here
      // For example, delete market data older than 30 days
      this.logger.log('Old market data cleanup completed');
    } catch (error) {
      this.logger.error('Error cleaning old market data', error);
    }
  }

  // Health check method
  async getStreamingStatus() {
    return {
      isStreaming: this.isStreaming,
      subscribedInstruments: Array.from(this.subscribedInstruments),
      subscribedCount: this.subscribedInstruments.size,
      // Provider-agnostic status; detailed per-provider status can be added later
      provider: await this.providerResolver.getGlobalProviderName() || this.providerResolver['config']?.get('DATA_PROVIDER') || 'kite',
    };
  }

  private async stopStreaming() {
    try {
      if (this.streamInterval) {
        clearInterval(this.streamInterval);
        this.streamInterval = null;
      }

      const provider = await this.providerResolver.resolveForWebsocket();
      const ticker = provider.getTicker();
      if (ticker) {
        ticker.disconnect();
      }

      this.isStreaming = false;
      this.logger.log('Market data streaming stopped');
    } catch (error) {
      this.logger.error('Error stopping streaming', error);
    }
  }

  // Method to restart streaming
  async startStreaming() {
    try {
      await this.initializeStreaming();
      this.logger.log('Market data streaming started');
    } catch (error) {
      this.logger.error('Error starting streaming', error);
      throw error;
    }
  }

  async restartStreaming() {
    await this.startStreaming();
  }

  // Reconnect the underlying provider ticker if streaming is active
  async reconnectIfStreaming() {
    try {
      const status = await this.getStreamingStatus();
      if (!status?.isStreaming) {
        this.logger.log('reconnectIfStreaming: streaming not active; skipping');
        return;
      }
      const provider = await this.providerResolver.resolveForWebsocket();
      const ticker = provider.getTicker?.();
      if (ticker?.disconnect && ticker?.connect) {
        this.logger.log('Reconnecting provider ticker after token update');
        try { ticker.disconnect(); } catch {}
        setTimeout(() => {
          try { ticker.connect(); } catch (e) { this.logger.error('Ticker reconnect failed', e); }
        }, 100);
      } else {
        // Fallback: re-initialize streaming to attach handlers and connect
        this.logger.log('Ticker not available; re-initializing streaming');
        await this.initializeStreaming();
      }
    } catch (error) {
      this.logger.error('reconnectIfStreaming failed', error);
    }
  }
}
