import { Injectable, Logger } from '@nestjs/common';
import { MarketDataProvider } from '../providers/market-data.provider';
import { ProviderQueueService } from './provider-queue.service';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: any) => void;
  tokens: string[];
  requestType: 'quote' | 'ltp' | 'ohlc';
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

  constructor(private providerQueue: ProviderQueueService) {
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

      // Enrichment pass: ensure last_price present; do one provider.getLTP call for missing
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
            `[Batching] Missing LTP for ${missingTokens.length}/${results.size} tokens → fetching LTP fallback`,
          );
          const ltpMap = await provider.getLTP(missingTokens);
          for (const tok of missingTokens) {
            const lv = ltpMap?.[tok]?.last_price;
            if (Number.isFinite(lv) && lv > 0) {
              const orig = results.get(tok) || {};
              results.set(tok, { ...(orig as any), last_price: lv });
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
