/**
 * @file request-batching.service.ts
 * @module services
 * @description Centralized batching for market data requests with a 1/sec distributed gate.
 *              Adds pair-based LTP batching and 5s stale-fill for consistency.
 * @author BharatERP
 * @created 2025-11-13
 */
import { Injectable, Logger } from '@nestjs/common';
import { MarketDataProvider } from '../providers/market-data.provider';
import { ProviderQueueService } from './provider-queue.service';
import { MarketDataStreamService } from './market-data-stream.service';

// Ambient declarations for timers in environments lacking lib.dom types
declare function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: any) => void;
  tokens: string[];
  requestType: 'quote' | 'ltp' | 'ohlc';
  timestamp: number;
}

interface Pair {
  exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO';
  token: string | number;
}

interface PendingPairRequest {
  resolve: (value: Record<string, { last_price: number | null }>) => void;
  reject: (error: any) => void;
  pairs: Pair[];
  requestType: 'ltp_pairs';
  timestamp: number;
}

interface BatchMetrics {
  totalRequests: number;
  uniqueInstruments: number;
  batchedCalls: number;
  deduplicationRatio: number;
  lastBatchTime: number;
  modeBreakdown: Record<string, number>;
}

@Injectable()
export class RequestBatchingService {
  private readonly logger = new Logger(RequestBatchingService.name);
  private pendingRequests: Map<string, PendingRequest[]> = new Map();
  private pendingPairRequests: Map<string, PendingPairRequest[]> = new Map();
  private batchTimeout = 1000; // 1 second batch window for per-second batching
  private maxBatchSize = 1000; // Maximum tokens per batch (Vortex limit)
  private batchMetrics: BatchMetrics = {
    totalRequests: 0,
    uniqueInstruments: 0,
    batchedCalls: 0,
    deduplicationRatio: 0,
    lastBatchTime: 0,
    modeBreakdown: {},
  };

  constructor(
    private providerQueue: ProviderQueueService,
    private marketDataStream: MarketDataStreamService,
  ) {
    // Log batching metrics every 10 seconds
    setInterval(() => {
      this.logBatchingMetrics();
    }, 10000);
  }

  async getQuote(tokens: string[], provider: MarketDataProvider): Promise<any> {
    return this.batchRequest(tokens, 'quote', provider);
  }

  async getLTP(tokens: string[], provider: MarketDataProvider): Promise<any> {
    return this.batchRequest(tokens, 'ltp', provider);
  }

  async getOHLC(tokens: string[], provider: MarketDataProvider): Promise<any> {
    return this.batchRequest(tokens, 'ohlc', provider);
  }

  /**
   * Pair-based batching for LTP (EXCHANGE-TOKEN).
   * - Coalesces within 1s window
   * - Dedupes by pair key
   * - Chunks to 1000 and executes via distributed 1/sec gate
   * - Fills missing using memory/Redis last_tick (≤ 5s old) for consistency
   */
  async getLtpByPairs(
    pairs: Pair[],
    provider: any,
  ): Promise<Record<string, { last_price: number | null }>> {
    return new Promise((resolve, reject) => {
      const batchWindow = Math.floor(Date.now() / this.batchTimeout);
      const requestKey = `ltp_pairs_${batchWindow}`;

      if (!this.pendingPairRequests.has(requestKey)) {
        this.pendingPairRequests.set(requestKey, []);
        setTimeout(() => {
          this.processPairsBatch(requestKey, provider);
        }, this.batchTimeout);
      }

      this.pendingPairRequests.get(requestKey)!.push({
        resolve,
        reject,
        pairs,
        requestType: 'ltp_pairs',
        timestamp: Date.now(),
      });

      // Update metrics
      this.batchMetrics.totalRequests++;
      this.batchMetrics.modeBreakdown['ltp_pairs'] =
        (this.batchMetrics.modeBreakdown['ltp_pairs'] || 0) + 1;
    });
  }

  private async batchRequest(
    tokens: string[],
    requestType: 'quote' | 'ltp' | 'ohlc',
    provider: MarketDataProvider,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // Use a time-based key for per-second batching
      const batchWindow = Math.floor(Date.now() / this.batchTimeout);
      const requestKey = `${requestType}_${batchWindow}`;

      // Add request to pending queue
      if (!this.pendingRequests.has(requestKey)) {
        this.pendingRequests.set(requestKey, []);

        // Schedule batch processing for this window
        setTimeout(() => {
          this.processBatch(requestKey, provider);
        }, this.batchTimeout);
      }

      this.pendingRequests.get(requestKey)!.push({
        resolve,
        reject,
        tokens,
        requestType,
        timestamp: Date.now(),
      });

      // Update metrics
      this.batchMetrics.totalRequests++;
      this.batchMetrics.modeBreakdown[requestType] =
        (this.batchMetrics.modeBreakdown[requestType] || 0) + 1;
    });
  }

  private async processBatch(requestKey: string, provider: MarketDataProvider) {
    const requests = this.pendingRequests.get(requestKey);
    if (!requests || requests.length === 0) {
      return;
    }

    this.pendingRequests.delete(requestKey);
    const startTime = Date.now();

    try {
      // Combine all tokens from pending requests with deduplication
      const allTokens = new Set<string>();
      const requestType = requests[0].requestType;

      requests.forEach((request) => {
        request.tokens.forEach((token) => allTokens.add(token));
      });

      const tokensArray = Array.from(allTokens);
      const deduplicationRatio =
        requests.length > 0
          ? (tokensArray.length /
              requests.reduce((sum, req) => sum + req.tokens.length, 0)) *
            100
          : 100;

      // Update metrics
      this.batchMetrics.uniqueInstruments += tokensArray.length;
      this.batchMetrics.lastBatchTime = startTime;

      this.logger.log(
        `[Batching] Processing batch: ${requests.length} user requests → ${tokensArray.length} unique instruments (${deduplicationRatio.toFixed(1)}% deduplication)`,
      );

      // Split into chunks if too large
      const chunks = this.chunkArray(tokensArray, this.maxBatchSize);
      const results = new Map<string, any>();
      let batchedCalls = 0;

      // Process each chunk
      for (const chunk of chunks) {
        let chunkResult: any;

        try {
          const chunkStartTime = Date.now();
          const endpoint =
            requestType === 'quote' ? 'quotes' : (requestType as any);
          chunkResult = await this.providerQueue.execute(
            endpoint as any,
            async () => {
              switch (requestType) {
                case 'quote':
                  return await provider.getQuote(chunk);
                case 'ltp':
                  return await provider.getLTP(chunk);
                case 'ohlc':
                  return await provider.getOHLC(chunk);
              }
            },
          );

          batchedCalls++;
          const chunkTime = Date.now() - chunkStartTime;

          // Merge results
          if (chunkResult) {
            Object.entries(chunkResult).forEach(([key, value]) => {
              results.set(key, value);
            });
          }

          this.logger.debug(
            `[Batching] Chunk ${chunk.length} tokens processed in ${chunkTime}ms`,
          );
        } catch (error) {
          this.logger.error(
            `[Batching] Error processing chunk for ${requestType}`,
            error,
          );
          // Reject all requests in this chunk
          requests.forEach((request) => {
            if (request.tokens.some((token) => chunk.includes(token))) {
              request.reject(error);
            }
          });
          continue;
        }
      }

      // Update batching metrics
      this.batchMetrics.batchedCalls += batchedCalls;
      const totalTime = Date.now() - startTime;
      const reductionPercentage =
        requests.length > 0
          ? ((requests.length - batchedCalls) / requests.length) * 100
          : 0;

      this.logger.log(
        `[Batching] Batch completed: ${requests.length} requests → ${batchedCalls} provider calls (${reductionPercentage.toFixed(1)}% reduction) in ${totalTime}ms`,
      );

      // Enrichment pass: ensure last_price present; prefer 5s stale fill; then one provider.getLTP call for the rest (under gate)
      try {
        const missingTokens = Array.from(
          new Set<string>(
            Array.from(results.entries())
              .filter(
                ([, v]) =>
                  !Number.isFinite((v as any)?.last_price) ||
                  ((v as any)?.last_price ?? 0) <= 0,
              )
              .map(([k]) => k),
          ),
        );
        if (missingTokens.length) {
          this.logger.warn(
            `[Batching] Missing LTP for ${missingTokens.length}/${results.size} tokens → attempting 5s stale fill`,
          );
          // 1) Try memory + Redis last_tick (consistent up to 5s)
          const stale = await this.marketDataStream.getRecentLTP(missingTokens);
          const stillMissing: string[] = [];
          for (const tok of missingTokens) {
            const lv = stale?.[tok]?.last_price;
            if (Number.isFinite(lv as any) && (lv as any) > 0) {
              const orig = results.get(tok) || {};
              results.set(tok, { ...(orig as any), last_price: lv });
            } else {
              stillMissing.push(tok);
            }
          }
          // 2) Optionally fetch provider fallback for any remaining under gate
          if (stillMissing.length) {
            this.logger.warn(
              `[Batching] ${stillMissing.length} tokens still missing after stale fill → gated provider LTP fallback`,
            );
            const ltpMap = await this.providerQueue.execute('ltp' as any, async () =>
              (provider as any).getLTP(stillMissing),
            );
            for (const tok of stillMissing) {
              const lv = ltpMap?.[tok]?.last_price;
              if (Number.isFinite(lv) && lv > 0) {
                const orig = results.get(tok) || {};
                results.set(tok, { ...(orig as any), last_price: lv });
              }
            }
          }
        }
      } catch (enrichErr) {
        this.logger.warn(
          '[Batching] LTP enrichment failed (non-fatal)',
          enrichErr as any,
        );
      }

      // Resolve all requests with their respective data (after enrichment)
      requests.forEach((request) => {
        const requestData: any = {};
        request.tokens.forEach((token) => {
          if (results.has(token)) {
            requestData[token] = results.get(token);
          }
        });
        request.resolve(requestData);
      });
    } catch (error) {
      this.logger.error(
        `[Batching] Error processing batch for ${requestKey}`,
        error,
      );
      // Reject all requests
      requests.forEach((request) => {
        request.reject(error);
      });
    }
  }

  private async processPairsBatch(requestKey: string, provider: any) {
    const requests = this.pendingPairRequests.get(requestKey);
    if (!requests || requests.length === 0) {
      return;
    }
    this.pendingPairRequests.delete(requestKey);
    const startTime = Date.now();
    try {
      // Collect and dedupe pairs by key
      const allowed = new Set(['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO']);
      const allPairs: Pair[] = [];
      for (const req of requests) {
        for (const p of req.pairs || []) {
          const ex = String(p?.exchange || '').toUpperCase();
          const tok = String(p?.token ?? '').trim();
          if (allowed.has(ex) && /^\d+$/.test(tok)) {
            allPairs.push({ exchange: ex as any, token: tok });
          }
        }
      }
      const keys = Array.from(
        new Set(allPairs.map((p) => `${String(p.exchange)}-${String(p.token)}`)),
      );
      const uniquePairs: Pair[] = keys.map((k) => {
        const [ex, tok] = k.split('-');
        return { exchange: ex as any, token: tok };
      });

      this.batchMetrics.uniqueInstruments += uniquePairs.length;
      this.batchMetrics.lastBatchTime = startTime;
      this.logger.log(
        `[Batching] Processing PAIRS batch: ${requests.length} user requests → ${uniquePairs.length} unique pairs`,
      );

      // Chunk to 1000 and call provider under distributed gate
      const chunks = this.chunkArray(uniquePairs, this.maxBatchSize);
      const results: Record<string, { last_price: number | null }> = {};
      let batchedCalls = 0;
      for (const chunk of chunks) {
        try {
          const chunkStart = Date.now();
          const map = await this.providerQueue.execute('ltp' as any, async () =>
            (provider as any).getLTPByPairs(chunk),
          );
          batchedCalls++;
          const elapsed = Date.now() - chunkStart;
          Object.assign(results, map || {});
          this.logger.debug(
            `[Batching] PAIRS chunk ${chunk.length} processed in ${elapsed}ms`,
          );
        } catch (error) {
          this.logger.error('[Batching] Error processing PAIRS chunk', error);
          // Reject all requests containing any of these chunk pairs
          requests.forEach((request) => {
            if (
              request.pairs.some((p) =>
                chunk.some(
                  (c) =>
                    String(c.exchange).toUpperCase() ===
                      String(p.exchange).toUpperCase() &&
                    String(c.token) === String(p.token),
                ),
              )
            ) {
              request.reject(error);
            }
          });
        }
      }

      this.batchMetrics.batchedCalls += batchedCalls;
      const totalTime = Date.now() - startTime;
      this.logger.log(
        `[Batching] PAIRS batch completed: ${requests.length} requests → ${batchedCalls} provider calls in ${totalTime}ms`,
      );

      // Stale fill for any pairs missing/invalid last_price using memory+Redis last_tick (≤5s)
      try {
        const missingKeys = keys.filter(
          (k) =>
            !Number.isFinite((results as any)?.[k]?.last_price) ||
            (((results as any)?.[k]?.last_price ?? 0) <= 0),
        );
        if (missingKeys.length) {
          const missingTokens = Array.from(
            new Set(
              missingKeys
                .map((k) => String(k.split('-').pop() || '').trim())
                .filter((s) => /^\d+$/.test(s)),
            ),
          );
          if (missingTokens.length) {
            const staleMap = await this.marketDataStream.getRecentLTP(
              missingTokens,
            );
            for (const k of missingKeys) {
              const tok = String(k.split('-').pop() || '').trim();
              const lp = staleMap?.[tok]?.last_price;
              if (Number.isFinite(lp as any) && (lp as any) > 0) {
                results[k] = { last_price: lp as any };
              }
            }
          }
        }
      } catch (e) {
        this.logger.warn(
          '[Batching] PAIRS stale fill failed (non-fatal)',
          e as any,
        );
      }

      // Ensure all requested keys present
      for (const k of keys) {
        if (!(k in results)) results[k] = { last_price: null };
      }

      // Resolve each request slice
      requests.forEach((req) => {
        const slice: Record<string, { last_price: number | null }> = {};
        for (const p of req.pairs) {
          const key = `${String(p.exchange).toUpperCase()}-${String(
            p.token,
          ).trim()}`;
          slice[key] = results[key] ?? { last_price: null };
        }
        req.resolve(slice);
      });
    } catch (error) {
      this.logger.error(
        `[Batching] Error processing PAIRS batch for ${requestKey}`,
        error,
      );
      requests.forEach((req) => req.reject(error));
    }
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  // Method to get batch statistics
  getBatchStats() {
    const totalPending = Array.from(this.pendingRequests.values()).reduce(
      (sum, requests) => sum + requests.length,
      0,
    );

    return {
      pendingRequests: totalPending,
      batchTimeout: this.batchTimeout,
      maxBatchSize: this.maxBatchSize,
      metrics: this.batchMetrics,
    };
  }

  // Method to log batching metrics periodically
  private logBatchingMetrics() {
    if (this.batchMetrics.totalRequests > 0) {
      const avgDeduplication =
        this.batchMetrics.batchedCalls > 0
          ? ((this.batchMetrics.totalRequests -
              this.batchMetrics.batchedCalls) /
              this.batchMetrics.totalRequests) *
            100
          : 0;

      this.logger.log(
        `[Batching] Metrics: ${this.batchMetrics.totalRequests} total requests, ${this.batchMetrics.batchedCalls} provider calls, ${avgDeduplication.toFixed(1)}% reduction, modes: ${JSON.stringify(this.batchMetrics.modeBreakdown)}`,
      );
    }
  }

  // Method to reset metrics
  resetMetrics() {
    this.batchMetrics = {
      totalRequests: 0,
      uniqueInstruments: 0,
      batchedCalls: 0,
      deduplicationRatio: 0,
      lastBatchTime: 0,
      modeBreakdown: {},
    };
  }
}
