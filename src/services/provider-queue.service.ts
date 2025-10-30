import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';
import { MetricsService } from './metrics.service';

type EndpointKey = 'quotes' | 'ltp' | 'ohlc' | 'history';

@Injectable()
export class ProviderQueueService {
  private readonly logger = new Logger(ProviderQueueService.name);

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
      // Didn't acquire - sleep until TTL + small jitter
      let waitMs = await this.redis.pttl(lockKey);
      if (typeof waitMs !== 'number' || waitMs < 0) {
        waitMs = 250; // default small backoff
      }
      // Add jitter to avoid thundering herd when lock expires
      const extra = 25 + Math.floor(Math.random() * 75);
      await new Promise((r) => setTimeout(r, waitMs + extra));
    }
  }
}
