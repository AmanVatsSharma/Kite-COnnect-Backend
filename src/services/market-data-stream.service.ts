import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MarketDataProviderResolverService } from './market-data-provider-resolver.service';
import { MarketDataProvider } from '../providers/market-data.provider';
import { StockService } from '../modules/stock/stock.service';
import { RedisService } from './redis.service';
import { LtpMemoryCacheService } from './ltp-memory-cache.service';
import { MetricsService } from './metrics.service';

@Injectable()
export class MarketDataStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketDataStreamService.name);
  private isStreaming = false;
  private subscribedInstruments: Set<number> = new Set();
  private streamInterval: NodeJS.Timeout | null = null;
  private subscriptionQueue: Map<
    number,
    { mode: 'ltp' | 'ohlcv' | 'full'; timestamp: number; clients: Set<string> }
  > = new Map();
  private unsubscriptionQueue: Set<number> = new Set();
  private subscriptionBatchInterval: NodeJS.Timeout | null = null;

  constructor(
    private providerResolver: MarketDataProviderResolverService,
    @Inject(forwardRef(() => StockService)) private stockService: StockService,
    private redisService: RedisService,
    private ltpCache: LtpMemoryCacheService,
    private metrics: MetricsService,
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
            try {
              ticker.connect?.();
            } catch (e2) {
              this.logger.error('Error connecting provider ticker', e2);
            }
          }, 0);
        } catch (e) {
          this.logger.error('Error scheduling provider ticker connect', e);
        }
      } else {
        this.logger.warn(
          'Ticker not initialized; ensure provider is configured and authenticated (Kite or Vortex)',
        );
      }

      this.logger.log('Market data streaming service initialized');
    } catch (error) {
      this.logger.error('Failed to initialize market data streaming', error);
    }
  }

  private async handleTicks(ticks: any[]) {
    try {
      console.log(
        `[MarketDataStreamService] Received ${ticks.length} ticks from provider`,
      );
      this.logger.debug(`[StreamBatching] Handling ${ticks.length} ticks`);

      for (const tick of ticks) {
        const instrumentToken = tick.instrument_token;

        // Update subscribed instruments set first
        this.subscribedInstruments.add(instrumentToken);

        console.log(
          `[MarketDataStreamService] Processing tick for token ${instrumentToken}: last_price=${tick.last_price}`,
        );

        // Update in-memory LTP cache first for hot-read path
        try {
          const lp = Number(tick.last_price);
          if (Number.isFinite(lp) && lp > 0) {
            this.ltpCache.set(instrumentToken, lp);
          }
        } catch {}

        // Store market data in database and broadcast (non-blocking if DB fails)
        try {
          await this.stockService.storeMarketData(instrumentToken, tick);
          console.log(
            `[MarketDataStreamService] Successfully stored and broadcasted tick for token ${instrumentToken}`,
          );
        } catch (storeError) {
          // Log but continue processing - broadcast still happens
          console.error(
            `[MarketDataStreamService] Failed to store tick for ${instrumentToken}:`,
            storeError,
          );
          this.logger.debug(
            `Failed to store tick for ${instrumentToken}, continuing with broadcast: ${storeError.message}`,
          );
        }
      }

      console.log(
        `[MarketDataStreamService] Completed processing ${ticks.length} ticks`,
      );
    } catch (error) {
      console.error(`[MarketDataStreamService] Error handling ticks:`, error);
      this.logger.error('Error handling ticks', error);
    }
  }

  async subscribeToInstruments(
    instrumentTokens: number[],
    mode: 'ltp' | 'ohlcv' | 'full' = 'ltp',
    clientId?: string,
  ) {
    try {
      console.log(
        `[MarketDataStreamService] subscribeToInstruments called: tokens=${JSON.stringify(instrumentTokens)}, mode=${mode}, clientId=${clientId || 'none'}`,
      );
      this.logger.log(
        `[StreamBatching] Received subscription request for ${instrumentTokens.length} instruments with mode=${mode} from client=${clientId || 'unknown'}`,
      );

      // Queue subscriptions for batching instead of immediate execution
      const newTokens: number[] = [];
      const existingTokens: number[] = [];

      instrumentTokens.forEach((token) => {
        if (!this.subscriptionQueue.has(token)) {
          this.subscriptionQueue.set(token, {
            mode,
            timestamp: Date.now(),
            clients: new Set(),
          });
          newTokens.push(token);
          console.log(
            `[MarketDataStreamService] Added new token ${token} to subscription queue with mode=${mode}`,
          );
        } else {
          existingTokens.push(token);
        }

        const subscription = this.subscriptionQueue.get(token)!;
        if (clientId) {
          subscription.clients.add(clientId);
          console.log(
            `[MarketDataStreamService] Added client ${clientId} to subscription for token ${token}`,
          );
        }

        // Update mode if it's higher priority (full > ohlcv > ltp)
        const modePriority = { ltp: 1, ohlcv: 2, full: 3 };
        const oldMode = subscription.mode;
        if (modePriority[mode] > modePriority[subscription.mode]) {
          subscription.mode = mode;
          console.log(
            `[MarketDataStreamService] Upgraded mode for token ${token} from ${oldMode} to ${mode}`,
          );
        }
      });

      // Start batching interval if not already started
      if (!this.subscriptionBatchInterval) {
        console.log(
          `[MarketDataStreamService] Starting subscription batch processing interval`,
        );
        this.startSubscriptionBatching();
      }

      this.logger.log(
        `[StreamBatching] Queued ${instrumentTokens.length} instruments (${newTokens.length} new, ${existingTokens.length} existing) for subscription with mode=${mode}, client=${clientId || 'unknown'}`,
      );
      if (newTokens.length > 0) {
        console.log(
          `[MarketDataStreamService] New tokens queued: ${JSON.stringify(newTokens)}`,
        );
      }
    } catch (error) {
      console.error(
        `[MarketDataStreamService] Error queuing instrument subscriptions:`,
        error,
      );
      this.logger.error('Error queuing instrument subscriptions', error);
      throw error;
    }
  }

  async unsubscribeFromInstruments(
    instrumentTokens: number[],
    clientId?: string,
  ) {
    try {
      // Queue unsubscriptions for batching
      instrumentTokens.forEach((token) => {
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

      this.logger.log(
        `[StreamBatching] Queued ${instrumentTokens.length} instruments for unsubscription`,
      );
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
      if (
        this.subscriptionQueue.size === 0 &&
        this.unsubscriptionQueue.size === 0
      ) {
        return;
      }

      console.log(
        `[MarketDataStreamService] Processing subscription batch: ${this.subscriptionQueue.size} subscriptions, ${this.unsubscriptionQueue.size} unsubscriptions`,
      );
      this.logger.log(
        `[StreamBatching] Processing batch: ${this.subscriptionQueue.size} subscriptions, ${this.unsubscriptionQueue.size} unsubscriptions`,
      );

      const provider = await this.providerResolver.resolveForWebsocket();
      const ticker = provider.getTicker();
      if (!ticker || !this.isStreaming) {
        console.warn(
          `[MarketDataStreamService] Cannot process batch: ticker=${!!ticker}, isStreaming=${this.isStreaming}`,
        );
        this.logger.warn(
          `[StreamBatching] Cannot process: ticker=${!!ticker}, isStreaming=${this.isStreaming}`,
        );
        return;
      }

      // Process subscriptions
      if (this.subscriptionQueue.size > 0) {
        const subscriptions = Array.from(this.subscriptionQueue.entries());
        const tokensToSubscribe = subscriptions.map(([token]) => token);

        console.log(
          `[MarketDataStreamService] Processing ${tokensToSubscribe.length} subscriptions: ${JSON.stringify(tokensToSubscribe)}`,
        );

        // Group by mode for efficient batching
        const modeGroups = new Map<string, number[]>();
        subscriptions.forEach(([token, sub]) => {
          if (!modeGroups.has(sub.mode)) {
            modeGroups.set(sub.mode, []);
          }
          modeGroups.get(sub.mode)!.push(token);
        });

        console.log(
          `[MarketDataStreamService] Grouped subscriptions by mode:`,
          Array.from(modeGroups.entries()).map(
            ([mode, tokens]) => `${mode}: ${tokens.length} tokens`,
          ),
        );

        // Subscribe by mode groups
        for (const [mode, tokens] of modeGroups) {
          console.log(
            `[MarketDataStreamService] Calling ticker.subscribe() for ${tokens.length} tokens with mode=${mode}`,
          );
          this.logger.log(
            `[StreamBatching] Subscribing ${tokens.length} tokens with mode=${mode} to provider`,
          );
          ticker.subscribe(tokens, mode as 'ltp' | 'ohlcv' | 'full');
          tokens.forEach((token) => {
            this.subscribedInstruments.add(token);
            console.log(
              `[MarketDataStreamService] Added token ${token} to subscribedInstruments set`,
            );
          });
        }

        this.logger.log(
          `[StreamBatching] Processed ${tokensToSubscribe.length} subscriptions in ${modeGroups.size} mode groups`,
        );
        console.log(
          `[MarketDataStreamService] Completed subscription batch processing for ${tokensToSubscribe.length} tokens`,
        );
        this.subscriptionQueue.clear();
      }

      // Process unsubscriptions
      if (this.unsubscriptionQueue.size > 0) {
        const tokensToUnsubscribe = Array.from(this.unsubscriptionQueue);
        console.log(
          `[MarketDataStreamService] Processing ${tokensToUnsubscribe.length} unsubscriptions: ${JSON.stringify(tokensToUnsubscribe)}`,
        );
        ticker.unsubscribe(tokensToUnsubscribe);
        tokensToUnsubscribe.forEach((token) => {
          this.subscribedInstruments.delete(token);
          console.log(
            `[MarketDataStreamService] Removed token ${token} from subscribedInstruments set`,
          );
        });

        this.logger.log(
          `[StreamBatching] Processed ${tokensToUnsubscribe.length} unsubscriptions`,
        );
        console.log(
          `[MarketDataStreamService] Completed unsubscription batch processing for ${tokensToUnsubscribe.length} tokens`,
        );
        this.unsubscriptionQueue.clear();
      }
    } catch (error) {
      console.error(
        `[MarketDataStreamService] Error processing subscription batch:`,
        error,
      );
      this.logger.error(
        '[StreamBatching] Error processing subscription batch',
        error,
      );
    }
  }

  async setMode(mode: string, instrumentTokens: number[]) {
    try {
      const provider = await this.providerResolver.resolveForWebsocket();
      const ticker = provider.getTicker();
      if (ticker && this.isStreaming) {
        ticker.setMode(mode, instrumentTokens);
        this.logger.log(
          `Set mode ${mode} for ${instrumentTokens.length} instruments`,
        );
      }
    } catch (error) {
      this.logger.error('Error setting ticker mode', error);
      throw error;
    }
  }

  /**
   * Batch helper for last known LTPs from Redis for tokens.
   * Always returns all requested tokens, logs per miss, never throws.
   * @param tokens string[] array of instrument tokens as string or number
   * @returns { token: { last_price: number|null } }
   */
  async getRecentLTP(
    tokens: string[],
  ): Promise<Record<string, { last_price: number | null }>> {
    const out: Record<string, { last_price: number | null }> = {};
    if (!Array.isArray(tokens) || tokens.length === 0) return out;
    let memHits = 0,
      redisHits = 0,
      misses = 0;
    // First pass: memory cache
    const mem = this.ltpCache.getMany(tokens);
    Object.entries(mem).forEach(([k, v]) => {
      if (Number.isFinite(v.last_price) && (v.last_price as any) > 0) {
        out[k] = { last_price: v.last_price };
        memHits++;
      }
    });
    // Second pass: Redis for remaining
    const remaining = tokens.filter((t) => !(t.toString() in out));
    for (const tRaw of remaining) {
      const t = tRaw.toString();
      try {
        const data: any = await this.redisService.get(`last_tick:${t}`);
        const lp = Number(data?.last_price);
        if (Number.isFinite(lp) && lp > 0) {
          out[t] = { last_price: lp };
          // Warm memory cache with Redis value to improve hit rate
          this.ltpCache.set(t, lp);
          redisHits++;
        } else {
          out[t] = { last_price: null };
          misses++;
        }
      } catch (err) {
        this.logger.warn(
          `[MarketDataStreamService] Redis fetch failed for last_tick:${t}`,
          err,
        );
        out[t] = { last_price: null };
        misses++;
      }
    }
    // Metrics
    if (memHits > 0)
      this.metrics.ltpCacheHitTotal.labels('memory').inc(memHits);
    if (redisHits > 0)
      this.metrics.ltpCacheHitTotal.labels('redis').inc(redisHits);
    if (misses > 0) this.metrics.ltpCacheMissTotal.labels('memory').inc(misses); // attribute misses to initial memory path
    this.logger.debug(
      `[MarketDataStreamService] getRecentLTP complete. Tokens=${tokens.length}, memHits=${memHits}, redisHits=${redisHits}, misses=${misses}`,
    );
    return out;
  }

  // Cron job to sync instruments daily (08:45, after CSV refresh ~08:30)
  @Cron('45 8 * * *')
  async syncInstrumentsDaily() {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.logger.log(
          `Starting daily instrument sync (attempt ${attempt}/${maxAttempts})`,
        );
        const result = await this.stockService.syncInstruments(undefined, {
          provider: 'vortex',
        });
        this.logger.log(
          `Daily sync completed: ${result.synced} synced, ${result.updated} updated`,
        );
        return;
      } catch (error) {
        this.logger.error(
          `Error in daily instrument sync (attempt ${attempt})`,
          error,
        );
        const delay = Math.min(60000, 5000 * Math.pow(2, attempt - 1));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    this.logger.error('Daily instrument sync failed after retries');
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
      provider:
        (await this.providerResolver.getGlobalProviderName()) ||
        this.providerResolver['config']?.get('DATA_PROVIDER') ||
        'kite',
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
        try {
          ticker.disconnect();
        } catch {}
        setTimeout(() => {
          try {
            ticker.connect();
          } catch (e) {
            this.logger.error('Ticker reconnect failed', e);
          }
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
