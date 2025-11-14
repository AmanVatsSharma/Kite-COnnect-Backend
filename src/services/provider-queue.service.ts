import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';
import { MetricsService } from './metrics.service';

type EndpointKey = 'quotes' | 'ltp' | 'ohlc' | 'history';

@Injectable()
export class ProviderQueueService {
  private readonly logger = new Logger(ProviderQueueService.name);
  // In-memory fallback throttle timestamps (per endpoint)
  private inMemLastExecAt: Record<EndpointKey, number> = {
    quotes: 0,
    ltp: 0,
    ohlc: 0,
    history: 0,
  };
  // Throttle warning logs to once per minute per endpoint
  private lastFallbackWarnAt: Record<EndpointKey, number> = {
    quotes: 0,
    ltp: 0,
    ohlc: 0,
    history: 0,
  };

  constructor(
    private redis: RedisService,
    private metrics: MetricsService,
  ) {}

  /**
   * Execute a provider call under a distributed 1/sec gate per endpoint with small jitter.
   * Ensures that across all instances, only one call per endpoint happens each second.
   * Adds 50–150ms jitter to spread bursts.
   */
  async execute<T>(endpoint: EndpointKey, fn: () => Promise<T>): Promise<T> {
    const lockKey = `vortex:rl:${endpoint}`;
    const start = Date.now();
    let attempts = 0;
    const maxSpinMs = 5000; // guardrail to avoid long stalls
    // Spin until we acquire the distributed lock
    // We keep waiting rather than failing to provide a provider-level queueing behavior
    for (;;) {
      attempts++;
      const jitter = 50 + Math.floor(Math.random() * 100); // 50–150ms
      const acquired = await this.redis.tryAcquireLock(lockKey, 1000 + jitter);
      if (acquired) {
        // Acquired the 1/sec window. Execute the function now.
        try {
          this.metrics.providerRequestsTotal.labels(endpoint).inc();
          const result = await fn();
          const elapsed = Date.now() - start;
          this.metrics.providerLatencySeconds
            .labels(endpoint)
            .observe(elapsed / 1000);
          this.logger.log(
            `[ProviderQueue] ${endpoint} served after ${elapsed}ms (attempts=${attempts})`,
          );
          return result;
        } catch (error) {
          const errLabel =
            (error as any)?.code || (error as any)?.name || 'error';
          this.metrics.providerRequestErrorsTotal
            .labels(endpoint, String(errLabel))
            .inc();
          this.logger.error(
            `[ProviderQueue] ${endpoint} execution failed`,
            error as any,
          );
          throw error;
        }
      }
      // Didn't acquire: check TTL to decide Redis health
      let waitMs = await this.redis.pttl(lockKey);
      const redisUnavailable = typeof waitMs !== 'number' || waitMs < 0;
      if (redisUnavailable) {
        // Fallback: in-memory 1/sec throttle when Redis is unavailable
        const now = Date.now();
        if (now - this.lastFallbackWarnAt[endpoint] > 60_000) {
          this.lastFallbackWarnAt[endpoint] = now;
          this.logger.warn(
            `[ProviderQueue] Falling back to in-memory throttle for ${endpoint} (Redis unavailable)`,
          );
        }
        return await this.executeWithInMemoryThrottle(endpoint, fn);
      }
      // Redis healthy and lock exists elsewhere: sleep until TTL + small jitter
      if (typeof waitMs !== 'number' || waitMs < 0) {
        waitMs = 250; // default small backoff
      }
      const extra = 25 + Math.floor(Math.random() * 75);
      await new Promise((r) => setTimeout(r, waitMs + extra));
      // Guardrail: if we've been spinning too long, fall back to in-memory to make progress
      if (Date.now() - start > maxSpinMs) {
        const now = Date.now();
        if (now - this.lastFallbackWarnAt[endpoint] > 60_000) {
          this.lastFallbackWarnAt[endpoint] = now;
          this.logger.warn(
            `[ProviderQueue] Spin exceeded ${maxSpinMs}ms for ${endpoint}; using in-memory throttle as guardrail`,
          );
        }
        return await this.executeWithInMemoryThrottle(endpoint, fn);
      }
    }
  }

  private async executeWithInMemoryThrottle<T>(
    endpoint: EndpointKey,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = Date.now();
    // Enforce at least 1s interval per endpoint with small jitter
    const jitter = 50 + Math.floor(Math.random() * 100);
    const minInterval = 1000 + jitter;
    const last = this.inMemLastExecAt[endpoint] || 0;
    const elapsed = Date.now() - last;
    if (elapsed < minInterval) {
      await new Promise((r) => setTimeout(r, minInterval - elapsed));
    }
    this.inMemLastExecAt[endpoint] = Date.now();
    try {
      this.metrics.providerRequestsTotal.labels(endpoint).inc();
      const result = await fn();
      const total = Date.now() - start;
      this.metrics.providerLatencySeconds.labels(endpoint).observe(total / 1000);
      this.logger.log(
        `[ProviderQueue] (fallback) ${endpoint} served after ${total}ms`,
      );
      return result;
    } catch (error) {
      const errLabel = (error as any)?.code || (error as any)?.name || 'error';
      this.metrics.providerRequestErrorsTotal
        .labels(endpoint, String(errLabel))
        .inc();
      this.logger.error(
        `[ProviderQueue] (fallback) ${endpoint} execution failed`,
        error as any,
      );
      throw error;
    }
  }
}
