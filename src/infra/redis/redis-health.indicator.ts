/**
 * File:        src/infra/redis/redis-health.indicator.ts
 * Module:      infra/redis
 * Purpose:     PING-based Redis health check with latency measurement. Consumed by HealthController to report Redis status on GET /api/health/detailed.
 *
 * Exports:
 *   - RedisHealthResult       — shape returned by check()
 *   - RedisHealthIndicator    — @Injectable() health check service
 *
 * Depends on:
 *   - RedisClientFactory   — source of the 'default' client used for PING
 *
 * Side-effects:
 *   - Issues one PING command per check() call (reads Redis)
 *
 * Key invariants:
 *   - PING has a 2-second hard timeout to avoid blocking the health endpoint
 *   - Returns unhealthy result (never throws) on any error
 *   - Returns not-configured when factory has no Redis configured
 *   - Returns not-ready when client exists but status !== 'ready'
 *
 * Read order:
 *   1. RedisHealthResult — data shape
 *   2. check() — single public method
 *
 * Author:      BharatERP
 * Last-updated: 2026-04-19
 */
import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { RedisClientFactory } from './redis-client.factory';

export interface RedisHealthResult {
  healthy: boolean;
  status: 'connected' | 'not-configured' | 'error' | 'not-ready';
  latencyMs: number;
  lastError?: string;
}

const PING_TIMEOUT_MS = 2000;

@Injectable()
export class RedisHealthIndicator {
  private readonly logger = new Logger(RedisHealthIndicator.name);

  constructor(private readonly factory: RedisClientFactory) {}

  async check(): Promise<RedisHealthResult> {
    if (!this.factory.isConfigured()) {
      return { healthy: false, status: 'not-configured', latencyMs: 0 };
    }

    const client = this.factory.getClient('default') as Redis | null;
    if (!client || client.status !== 'ready') {
      return { healthy: false, status: 'not-ready', latencyMs: 0 };
    }

    const t0 = Date.now();
    try {
      let timer: ReturnType<typeof setTimeout>;
      await Promise.race([
        client.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`PING timeout after ${PING_TIMEOUT_MS}ms`)),
            PING_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      const latencyMs = Date.now() - t0;
      this.logger.debug(`[RedisHealthIndicator] PING ok (${latencyMs}ms)`);
      return { healthy: true, status: 'connected', latencyMs };
    } catch (err: any) {
      const latencyMs = Date.now() - t0;
      this.logger.warn(`[RedisHealthIndicator] PING failed: ${err.message}`);
      return { healthy: false, status: 'error', latencyMs, lastError: err.message };
    }
  }
}
