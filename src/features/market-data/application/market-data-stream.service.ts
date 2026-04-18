/**
 * @file market-data-stream.service.ts
 * @module market-data
 * @description Orchestrates provider ticker streaming, subscription batching, LTP cache, and Redis stream status.
 * @author BharatERP
 * @created 2025-03-23
 * @updated 2026-04-19
 */
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MarketDataProviderResolverService } from '@features/market-data/application/market-data-provider-resolver.service';
import { MarketDataProvider } from '@features/market-data/infra/market-data.provider';
import { StockService } from '@features/stock/application/stock.service';
import { RedisService } from '@infra/redis/redis.service';
import { LtpMemoryCacheService } from '@features/market-data/application/ltp-memory-cache.service';
import { MetricsService } from '@infra/observability/metrics.service';
import { MarketDataWsInterestService } from '@features/market-data/application/market-data-ws-interest.service';
import { internalToClientProviderName, InternalProviderName } from '@shared/utils/provider-label.util';
import { InstrumentRegistryService } from '@features/market-data/application/instrument-registry.service';
import { denormalizeExchange } from '@shared/utils/exchange-normalizer';

@Injectable()
export class MarketDataStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketDataStreamService.name);
  private isStreaming = false;
  private activeProviderState = new Map<
    InternalProviderName,
    { ticker: any; subscribedUirIds: Set<number>; isConnected: boolean }
  >();
  private streamInterval: NodeJS.Timeout | null = null;
  private subscriptionQueue: Map<
    number,
    { mode: 'ltp' | 'ohlcv' | 'full'; timestamp: number; clients: Set<string> }
  > = new Map();
  private unsubscriptionQueue: Set<number> = new Set();
  private subscriptionBatchInterval: NodeJS.Timeout | null = null;
  private readonly SUBSCRIBE_CHUNK_SIZE = 500; // backpressure-friendly chunking
  /** Cap queued subscribe entries to limit memory under storms. */
  private readonly SUB_QUEUE_MAX = 50_000;
  private readonly UNSUB_QUEUE_MAX = 50_000;
  /** Kite upstream WebSocket limit: max 3000 instruments per connection. */
  private readonly KITE_UPSTREAM_INSTRUMENT_LIMIT = 3000;
  /** Attach stream-level ticker handlers once per ticker instance (avoids duplicates on re-init). */
  private readonly tickerStreamHandlersBound = new WeakMap<object, true>();
  private readonly rateLogAt = new Map<string, number>();
  /** Last raw tick per token (for synthetic pulse shape). */
  private readonly lastTickPayload = new Map<number, any>();
  /** Wall-clock ms of last upstream tick per token (real ticks only). */
  private readonly lastUpstreamAt = new Map<number, number>();
  private syntheticPulseTimer: NodeJS.Timeout | null = null;

  constructor(
    private providerResolver: MarketDataProviderResolverService,
    @Inject(forwardRef(() => StockService)) private stockService: StockService,
    private redisService: RedisService,
    private ltpCache: LtpMemoryCacheService,
    private metrics: MetricsService,
    private readonly wsInterest: MarketDataWsInterestService,
    private readonly configService: ConfigService,
    private readonly instrumentRegistry: InstrumentRegistryService,
  ) {}

  async onModuleInit() {
    // Do not auto-start streaming; wait for admin trigger
    this.startSyntheticPulseIfConfigured();
  }

  async onModuleDestroy() {
    if (this.syntheticPulseTimer) {
      clearInterval(this.syntheticPulseTimer);
      this.syntheticPulseTimer = null;
    }
    await this.stopStreaming();
  }

  private startSyntheticPulseIfConfigured() {
    const raw =
      this.configService.get<string>('MARKET_DATA_SYNTHETIC_INTERVAL_MS') ??
      process.env.MARKET_DATA_SYNTHETIC_INTERVAL_MS ??
      '0';
    const intervalMs = Number(raw);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }
    this.syntheticPulseTimer = setInterval(() => {
      void this.runSyntheticPulse(intervalMs);
    }, intervalMs);
    this.logger.log(
      `Synthetic market_data pulse enabled (MARKET_DATA_SYNTHETIC_INTERVAL_MS=${intervalMs})`,
    );
  }

  /**
   * Re-emit last known tick for tokens with WS subscribers when upstream has been
   * quiet for at least one interval (cadence for UI; not a new market event).
   */
  private async runSyntheticPulse(intervalMs: number): Promise<void> {
    try {
      const tokens = this.wsInterest.getInterestedTokens();
      const now = Date.now();
      for (const token of tokens) {
        const payload = this.lastTickPayload.get(token);
        if (!payload) continue;
        const lastUp = this.lastUpstreamAt.get(token);
        if (lastUp === undefined) continue;
        if (now - lastUp < intervalMs) continue;
        await this.stockService.forwardRealtimeTick(token, payload, {
          syntheticLast: true,
        });
        try {
          this.metrics.marketDataSyntheticTickTotal.inc();
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      this.logger.warn('Synthetic pulse failed', e as any);
    }
  }

  private rateLimitedLog(
    level: 'debug' | 'warn',
    key: string,
    message: string,
    minIntervalMs = 10_000,
  ) {
    const now = Date.now();
    if (now - (this.rateLogAt.get(key) || 0) < minIntervalMs) return;
    this.rateLogAt.set(key, now);
    if (level === 'warn') this.logger.warn(message);
    else this.logger.debug(message);
  }

  private ensureSubscriptionQueueCapacity(incomingNewTokens: number) {
    while (this.subscriptionQueue.size + incomingNewTokens > this.SUB_QUEUE_MAX) {
      const first = this.subscriptionQueue.keys().next().value;
      if (first === undefined) break;
      this.subscriptionQueue.delete(first);
      try {
        this.metrics.marketDataStreamQueueDroppedTotal
          .labels('subscribe_evict')
          .inc();
      } catch {}
    }
  }

  private trimUnsubscriptionQueue() {
    while (this.unsubscriptionQueue.size > this.UNSUB_QUEUE_MAX) {
      const first = this.unsubscriptionQueue.values().next().value;
      if (first === undefined) break;
      this.unsubscriptionQueue.delete(first);
      try {
        this.metrics.marketDataStreamQueueDroppedTotal
          .labels('unsubscribe_evict')
          .inc();
      } catch {}
    }
  }

  private async initializeStreaming() {
    try {
      const enabledProviders = this.providerResolver.getEnabledProviders();
      if (enabledProviders.length === 0) {
        this.logger.warn(
          'No providers are ready; market data WS is in degraded mode (configure credentials).',
        );
        try {
          this.redisService.publish('stream:status', {
            event: 'degraded',
            reason: 'no_providers',
            ts: Date.now(),
          });
        } catch {}
        return;
      }

      for (const providerName of enabledProviders) {
        const provider = this.providerResolver.getProvider(providerName);
        const ticker = provider.initializeTicker?.();
        if (!ticker?.on) {
          this.rateLimitedLog(
            'warn',
            `ticker_missing_${providerName}`,
            `[${providerName}] Ticker not initialized; skipping (configure credentials).`,
            60_000,
          );
          continue;
        }

        const state = { ticker, subscribedUirIds: new Set<number>(), isConnected: false };
        this.activeProviderState.set(providerName, state);

        if (!this.tickerStreamHandlersBound.has(ticker)) {
          this.tickerStreamHandlersBound.set(ticker, true);
          const clientLabel = internalToClientProviderName(providerName);

          ticker.on('ticks', (ticks: any[]) => {
            void this.handleTicks(providerName, ticks);
          });

          ticker.on('connect', () => {
            this.logger.log(`[${providerName}] Provider ticker connected`);
            state.isConnected = true;
            this.isStreaming = true;
            try {
              this.metrics.marketDataStreamTickerConnected.labels(providerName).set(1);
            } catch {}
            try {
              this.redisService.publish('stream:status', {
                event: 'connected',
                provider: clientLabel,
                providerName,
                ts: Date.now(),
              });
            } catch {}
          });

          ticker.on('disconnect', () => {
            this.logger.log(`[${providerName}] Provider ticker disconnected`);
            state.isConnected = false;
            this.isStreaming = Array.from(this.activeProviderState.values()).some((s) => s.isConnected);
            try {
              this.metrics.marketDataStreamTickerConnected.labels(providerName).set(0);
            } catch {}
            try {
              this.redisService.publish('stream:status', {
                event: 'disconnected',
                provider: clientLabel,
                providerName,
                ts: Date.now(),
              });
            } catch {}
          });

          ticker.on('error', (error: any) => {
            this.logger.error(`[${providerName}] Provider ticker error`, error);
            state.isConnected = false;
            this.isStreaming = Array.from(this.activeProviderState.values()).some((s) => s.isConnected);
            try {
              this.metrics.marketDataStreamTickerConnected.labels(providerName).set(0);
            } catch {}
            try {
              this.redisService.publish('stream:status', {
                event: 'error',
                provider: clientLabel,
                providerName,
                error: error?.message || 'unknown',
                ts: Date.now(),
              });
            } catch {}
          });
        }

        setTimeout(() => {
          try {
            ticker.connect?.();
          } catch (e) {
            this.logger.error(`[${providerName}] Error connecting provider ticker`, e);
          }
        }, 0);
      }

      this.logger.log(
        `Market data streaming initialized for providers: [${enabledProviders.join(', ')}]`,
      );
    } catch (error) {
      this.logger.error('Failed to initialize market data streaming', error);
    }
  }

  private async handleTicks(providerName: InternalProviderName, ticks: any[]) {
    try {
      if (!Array.isArray(ticks) || ticks.length === 0) return;
      try {
        this.metrics.marketDataStreamTicksIngestedTotal
          .labels(providerName)
          .inc(ticks.length);
      } catch {}
      this.logger.debug(
        `[StreamBatching] Ingesting tick batch count=${ticks.length} provider=${providerName}`,
      );

      for (const tick of ticks) {
        const instrumentToken = tick.instrument_token;

        // Resolve to UIR ID — all internal state keyed by UIR
        const uirId = this.instrumentRegistry.resolveProviderToken(
          providerName,
          instrumentToken,
        );
        if (uirId === undefined) {
          this.rateLimitedLog(
            'debug',
            `unmapped_tick:${instrumentToken}`,
            `Tick for unmapped provider token ${instrumentToken}; skipping (run sync to populate UIR)`,
            30_000,
          );
          continue;
        }
        tick._uirId = uirId;
        tick._canonicalSymbol = this.instrumentRegistry.getCanonicalSymbol(uirId);

        // Update in-memory LTP cache first for hot-read path
        try {
          const lp = Number(tick.last_price);
          if (Number.isFinite(lp) && lp > 0) {
            this.ltpCache.set(uirId, lp);
          }
        } catch {}

        this.lastTickPayload.set(uirId, { ...tick });
        this.lastUpstreamAt.set(uirId, Date.now());

        try {
          await this.stockService.forwardRealtimeTick(uirId, tick);
        } catch (storeError: any) {
          this.rateLimitedLog(
            'debug',
            `forward_tick_fail:${uirId}`,
            `Failed to forward tick for UIR ${uirId}, continuing: ${storeError?.message || storeError}`,
            30_000,
          );
        }
        this.stockService.enqueuePersistMarketData(uirId, tick);
      }
    } catch (error) {
      this.logger.error('Error handling ticks', error);
    }
  }

  async subscribeToInstruments(
    instrumentTokens: number[],
    mode: 'ltp' | 'ohlcv' | 'full' = 'ltp',
    clientId?: string,
  ) {
    try {
      this.logger.log(
        `[StreamBatching] Received subscription request for ${instrumentTokens.length} instruments with mode=${mode} from client=${clientId || 'unknown'}`,
      );

      const prospectiveNew = instrumentTokens.filter(
        (t) => !this.subscriptionQueue.has(t),
      ).length;
      this.ensureSubscriptionQueueCapacity(prospectiveNew);

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
        } else {
          existingTokens.push(token);
        }

        const subscription = this.subscriptionQueue.get(token)!;
        if (clientId) {
          subscription.clients.add(clientId);
        }

        // Update mode if it's higher priority (full > ohlcv > ltp)
        const modePriority = { ltp: 1, ohlcv: 2, full: 3 };
        if (modePriority[mode] > modePriority[subscription.mode]) {
          subscription.mode = mode;
        }
      });

      // Start batching interval if not already started
      if (!this.subscriptionBatchInterval) {
        this.startSubscriptionBatching();
      }

      this.logger.log(
        `[StreamBatching] Queued ${instrumentTokens.length} instruments (${newTokens.length} new, ${existingTokens.length} existing) for subscription with mode=${mode}, client=${clientId || 'unknown'}`,
      );
    } catch (error) {
      this.logger.error('Error queuing instrument subscriptions', error);
      throw error;
    }
  }

  /**
   * Subscribe using explicit exchange-token pairs. This primes the provider's
   * internal exchange mapping to ensure the upstream subscribe frames are
   * constructed with the correct exchange for each token, avoiding any default
   * fallbacks (e.g., NSE_EQ).
   */
  async subscribePairs(
    pairs: Array<{
      token: number;
      exchange: string;
    }>,
    mode: 'ltp' | 'ohlcv' | 'full' = 'ltp',
    clientId?: string,
  ) {
    try {
      if (!Array.isArray(pairs) || pairs.length === 0) {
        return;
      }
      // Exchange priming is handled per-provider inside processSubscriptionBatch
      const tokens = Array.from(new Set(pairs.map((p) => Number(p.token))));
      await this.subscribeToInstruments(tokens, mode, clientId);
    } catch (error) {
      this.logger.error('Error in subscribePairs', error);
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
      this.trimUnsubscriptionQueue();

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
    const t0 = Date.now();
    const providerLabelsUsed = new Set<InternalProviderName>();
    try {
      if (
        this.subscriptionQueue.size === 0 &&
        this.unsubscriptionQueue.size === 0
      ) {
        return;
      }

      this.logger.log(
        `[StreamBatching] Processing batch: ${this.subscriptionQueue.size} subscriptions, ${this.unsubscriptionQueue.size} unsubscriptions`,
      );

      // ── Subscriptions ────────────────────────────────────────────────────────
      if (this.subscriptionQueue.size > 0) {
        // Group queued UIR IDs by the best provider for each instrument
        const byProvider = new Map<
          InternalProviderName,
          Map<number, { mode: 'ltp' | 'ohlcv' | 'full' }>
        >();
        for (const [uirId, sub] of this.subscriptionQueue) {
          const prov = this.instrumentRegistry.getBestProviderForUirId(uirId);
          if (!prov || !this.activeProviderState.has(prov)) continue;
          if (!byProvider.has(prov)) byProvider.set(prov, new Map());
          byProvider.get(prov)!.set(uirId, { mode: sub.mode });
        }

        for (const [providerName, uirGroup] of byProvider) {
          const state = this.activeProviderState.get(providerName)!;
          if (!state.isConnected) {
            this.rateLimitedLog(
              'warn',
              `batch_skip_disconnected_${providerName}`,
              `[StreamBatching][${providerName}] Provider not connected; will retry next tick`,
              15_000,
            );
            continue;
          }
          providerLabelsUsed.add(providerName);
          const provider = this.providerResolver.getProvider(providerName);
          let subscriptions = Array.from(uirGroup.entries());

          // Enforce provider upstream instrument limit
          const limit =
            (provider as any).getSubscriptionLimit?.() ??
            this.KITE_UPSTREAM_INSTRUMENT_LIMIT;
          const capacity = limit - state.subscribedUirIds.size;
          if (capacity <= 0) {
            this.logger.warn(
              `[StreamBatching][${providerName}] Upstream limit (${limit}) reached; dropping ${subscriptions.length} queued UIR IDs`,
            );
            try {
              this.metrics.marketDataStreamQueueDroppedTotal
                .labels(`${providerName}_upstream_limit`)
                .inc(subscriptions.length);
            } catch {}
            subscriptions = [];
          } else if (subscriptions.length > capacity) {
            const dropped = subscriptions.length - capacity;
            this.logger.warn(
              `[StreamBatching][${providerName}] Upstream limit: capping to ${capacity} (dropping ${dropped})`,
            );
            try {
              this.metrics.marketDataStreamQueueDroppedTotal
                .labels(`${providerName}_upstream_limit`)
                .inc(dropped);
            } catch {}
            subscriptions = subscriptions.slice(0, capacity);
          }

          if (subscriptions.length === 0) continue;

          // Vortex exchange priming — supply token→exchange pairs before subscribe
          if (providerName === 'vortex') {
            const primePairs: Array<{ token: number; exchange: string }> = [];
            for (const [uirId] of subscriptions) {
              const pt = this.instrumentRegistry.getProviderToken(uirId, 'vortex');
              const canon = this.instrumentRegistry.getCanonicalSymbol(uirId);
              const canonExch = canon?.split(':')[0] ?? '';
              const vortexExch = denormalizeExchange(canonExch, 'vortex');
              const tokenNum = parseInt((pt ?? '').split('-').pop() ?? pt ?? '', 10);
              if (!isNaN(tokenNum)) primePairs.push({ token: tokenNum, exchange: vortexExch });
            }
            if (primePairs.length) {
              try {
                provider.primeExchangeMapping?.(primePairs);
              } catch (e) {
                this.logger.warn('[StreamBatching][vortex] primeExchangeMapping failed', e as any);
              }
            }
          }

          // Group by mode then chunk-subscribe
          const modeGroups = new Map<string, number[]>();
          for (const [uirId, sub] of subscriptions) {
            if (!modeGroups.has(sub.mode)) modeGroups.set(sub.mode, []);
            modeGroups.get(sub.mode)!.push(uirId);
          }

          for (const [mode, uirIds] of modeGroups) {
            const providerTokens: (number | string)[] = [];
            for (const uirId of uirIds) {
              const pt = this.instrumentRegistry.getProviderToken(uirId, providerName);
              if (pt != null) {
                const numPt = Number(pt);
                providerTokens.push(Number.isFinite(numPt) ? numPt : pt);
              }
            }
            this.logger.log(
              `[StreamBatching][${providerName}] Subscribing ${providerTokens.length} tokens (${uirIds.length} UIR IDs) mode=${mode}`,
            );
            for (let i = 0; i < providerTokens.length; i += this.SUBSCRIBE_CHUNK_SIZE) {
              const chunk = providerTokens.slice(i, i + this.SUBSCRIBE_CHUNK_SIZE);
              state.ticker.subscribe(chunk, mode as 'ltp' | 'ohlcv' | 'full');
            }
            uirIds.forEach((uirId) => state.subscribedUirIds.add(uirId));
          }

          // Update Kite gauge
          if (providerName === 'kite') {
            try {
              this.metrics.kiteTickerSubscribedInstruments.set(state.subscribedUirIds.size);
            } catch {}
          }
        }

        this.subscriptionQueue.clear();
      }

      // ── Unsubscriptions ──────────────────────────────────────────────────────
      if (this.unsubscriptionQueue.size > 0) {
        const uirIdsToUnsubscribe = Array.from(this.unsubscriptionQueue);

        for (const [providerName, state] of this.activeProviderState) {
          providerLabelsUsed.add(providerName);
          const inThisProvider = uirIdsToUnsubscribe.filter((id) =>
            state.subscribedUirIds.has(id),
          );
          if (inThisProvider.length === 0) continue;

          const providerTokens: (number | string)[] = [];
          for (const uirId of inThisProvider) {
            const pt = this.instrumentRegistry.getProviderToken(uirId, providerName);
            if (pt != null) {
              const numPt = Number(pt);
              providerTokens.push(Number.isFinite(numPt) ? numPt : pt);
            }
          }
          for (let i = 0; i < providerTokens.length; i += this.SUBSCRIBE_CHUNK_SIZE) {
            state.ticker.unsubscribe(providerTokens.slice(i, i + this.SUBSCRIBE_CHUNK_SIZE));
          }
          inThisProvider.forEach((uirId) => state.subscribedUirIds.delete(uirId));

          this.logger.log(
            `[StreamBatching][${providerName}] Processed ${inThisProvider.length} unsubscriptions`,
          );
          if (providerName === 'kite') {
            try {
              this.metrics.kiteTickerSubscribedInstruments.set(state.subscribedUirIds.size);
            } catch {}
          }
        }

        this.unsubscriptionQueue.clear();
      }
    } catch (error) {
      this.logger.error(
        '[StreamBatching] Error processing subscription batch',
        error,
      );
    } finally {
      try {
        const elapsed = (Date.now() - t0) / 1000;
        // Emit metric for each provider that participated in this batch
        for (const prov of providerLabelsUsed) {
          this.metrics.marketDataStreamBatchSeconds.labels(prov).observe(elapsed);
        }
        if (providerLabelsUsed.size === 0) {
          this.metrics.marketDataStreamBatchSeconds.labels('none').observe(elapsed);
        }
      } catch {}
    }
  }

  async setMode(mode: string, instrumentTokens: number[]) {
    try {
      for (const [providerName, state] of this.activeProviderState) {
        if (!state.isConnected) continue;
        const relevant = instrumentTokens.filter((id) => state.subscribedUirIds.has(id));
        if (relevant.length === 0) continue;
        try {
          state.ticker.setMode(mode, relevant);
          this.logger.log(
            `[${providerName}] Set mode ${mode} for ${relevant.length} instruments`,
          );
        } catch (e) {
          this.logger.warn(`[${providerName}] setMode failed`, e as any);
        }
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

  /**
   * Health snapshot for /health and admin: streaming flags, queues, ticker presence.
   */
  async getMarketDataHealthSnapshot() {
    const providers: Record<string, { isConnected: boolean; subscribedCount: number }> = {};
    for (const [name, state] of this.activeProviderState) {
      providers[name] = { isConnected: state.isConnected, subscribedCount: state.subscribedUirIds.size };
    }
    const anyConnected = Object.values(providers).some((p) => p.isConnected);
    // Legacy fields derived from the first active provider for backward compat
    const firstEntry = this.activeProviderState.entries().next().value as
      | [InternalProviderName, { ticker: any; subscribedUirIds: Set<number>; isConnected: boolean }]
      | undefined;
    const legacyProviderLabel = firstEntry
      ? internalToClientProviderName(firstEntry[0])
      : 'Unknown';
    const legacyTickerReady = firstEntry ? !!firstEntry[1].ticker : false;
    return {
      provider: legacyProviderLabel,
      isStreaming: anyConnected,
      wsTickerReady: legacyTickerReady,
      marketDataDegraded: this.activeProviderState.size === 0,
      queues: this.getQueueStatus(),
      subscribedCount: this.getSubscribedInstrumentCount(),
      providers,
    };
  }

  // Health check method
  async getStreamingStatus() {
    const snapshot = await this.getMarketDataHealthSnapshot();
    return {
      isStreaming: snapshot.isStreaming,
      subscribedCount: snapshot.subscribedCount,
      provider: snapshot.provider,
      wsTickerReady: snapshot.wsTickerReady,
      marketDataDegraded: snapshot.marketDataDegraded,
      queues: snapshot.queues,
      providers: snapshot.providers,
      enabledProviders: Array.from(this.activeProviderState.keys()),
    };
  }

  /** Current count of instruments subscribed across all active providers. */
  getSubscribedInstrumentCount(): number {
    let total = 0;
    for (const [, state] of this.activeProviderState) total += state.subscribedUirIds.size;
    return total;
  }

  // Expose queue sizes for backpressure monitoring
  getQueueStatus() {
    try {
      const subSize = this.subscriptionQueue.size;
      const unsubSize = this.unsubscriptionQueue.size;
      // Update metrics gauges
      try {
        this.metrics.providerQueueDepth.labels('ws_subscribe').set(subSize);
        this.metrics.providerQueueDepth.labels('ws_unsubscribe').set(unsubSize);
      } catch {}
      return { subscribe: subSize, unsubscribe: unsubSize };
    } catch (e) {
      return { subscribe: 0, unsubscribe: 0 };
    }
  }

  private async stopStreaming() {
    try {
      if (this.subscriptionBatchInterval) {
        clearInterval(this.subscriptionBatchInterval);
        this.subscriptionBatchInterval = null;
      }
      if (this.streamInterval) {
        clearInterval(this.streamInterval);
        this.streamInterval = null;
      }

      for (const [providerName, state] of this.activeProviderState) {
        try { state.ticker?.disconnect?.(); } catch {}
        try { this.metrics.marketDataStreamTickerConnected.labels(providerName).set(0); } catch {}
      }
      this.activeProviderState.clear();

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

  // Reconnect all active provider tickers if streaming is active
  async reconnectIfStreaming() {
    try {
      if (!this.isStreaming && this.activeProviderState.size === 0) {
        this.logger.log('reconnectIfStreaming: streaming not active; skipping');
        return;
      }
      if (this.activeProviderState.size === 0) {
        this.logger.log('reconnectIfStreaming: no active providers; re-initializing');
        await this.initializeStreaming();
        return;
      }
      for (const [providerName, state] of this.activeProviderState) {
        if (!state.ticker?.disconnect || !state.ticker?.connect) continue;
        this.logger.log(`[${providerName}] Reconnecting provider ticker after token update`);
        try { state.ticker.disconnect(); } catch {}
        setTimeout(() => {
          try {
            state.ticker.connect();
          } catch (e) {
            this.logger.error(`[${providerName}] Ticker reconnect failed`, e);
          }
        }, 100);
      }
    } catch (error) {
      this.logger.error('reconnectIfStreaming failed', error);
    }
  }
}
