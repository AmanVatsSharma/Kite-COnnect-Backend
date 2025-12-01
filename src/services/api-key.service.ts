import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKey } from '../entities/api-key.entity';
import { RedisService } from './redis.service';

@Injectable()
export class ApiKeyService {
  constructor(
    @InjectRepository(ApiKey) private apiKeyRepo: Repository<ApiKey>,
    private redisService: RedisService,
  ) {}

  async validateApiKey(key: string): Promise<ApiKey | null> {
    const record = await this.apiKeyRepo.findOne({
      where: { key, is_active: true },
    });
    return record || null;
  }

  async incrementHttpUsage(key: string, limitPerMinute: number): Promise<void> {
    // Robust per-API-key HTTP rate limiter using 1‑minute buckets in Redis.
    // - If Redis is unavailable or fails, we *do not* block the request (fail‑open),
    //   but we log and console.error for later debugging.
    // - When the configured limit is exceeded, we throw a dedicated Error which
    //   callers (e.g. ApiKeyGuard) translate into a structured 4xx response.
    if (!limitPerMinute || limitPerMinute <= 0) {
      // No limit configured for this key – treat as unlimited.
      return;
    }

    const bucketKey = this.buildMinuteBucketKey('http', key);

    try {
      const current =
        (await this.redisService.get<number>(bucketKey)) || 0;

      if (current >= limitPerMinute) {
        // Console for easy later debugging
        // eslint-disable-next-line no-console
        console.log(
          '[ApiKeyService] HTTP rate limit exceeded',
          JSON.stringify({
            key,
            limitPerMinute,
            bucketKey,
            current,
          }),
        );
        throw new Error('Rate limit exceeded');
      }

      await this.redisService.set(bucketKey, current + 1, 65);
      // Console for easy later debugging (sampled by minute bucket)
      // eslint-disable-next-line no-console
      console.log(
        '[ApiKeyService] HTTP usage incremented',
        JSON.stringify({
          key,
          bucketKey,
          next: current + 1,
          limitPerMinute,
        }),
      );
    } catch (err) {
      if (err instanceof Error && err.message === 'Rate limit exceeded') {
        // Propagate semantic limit errors to caller.
        throw err;
      }
      // Any infrastructure failure (Redis/network/etc.) should not take
      // the API down. Log it for later inspection and fail‑open.
      // eslint-disable-next-line no-console
      console.error(
        '[ApiKeyService] Failed to increment HTTP usage – continuing without throttling',
        {
          key,
          bucketKey,
          error: (err as any)?.message ?? err,
        },
      );
    }
  }

  async trackWsConnection(key: string, connectionLimit: number): Promise<void> {
    const connKey = `ws:connections:${key}`;
    const current = await this.redisService.incr(connKey);
    if (current === 1) {
      await this.redisService.expire(connKey, 3600);
    }
    if (current > connectionLimit) {
      await this.redisService.decr(connKey);
      throw new Error('Connection limit exceeded');
    }
  }

  async untrackWsConnection(key: string): Promise<void> {
    const connKey = `ws:connections:${key}`;
    await this.redisService.decr(connKey);
  }

  async getUsageReport(key: string) {
    const httpKey = this.buildMinuteBucketKey('http', key);
    const wsKey = `ws:connections:${key}`;

    try {
      const [httpCount, wsCount] = await Promise.all([
        this.redisService.get<number>(httpKey),
        this.redisService.get<number>(wsKey),
      ]);
      return {
        httpRequestsThisMinute: httpCount || 0,
        currentWsConnections: wsCount || 0,
      };
    } catch (err) {
      // If Redis is down or another infra issue occurs, return a safe default
      // and log so admin dashboards remain available.
      // eslint-disable-next-line no-console
      console.error(
        '[ApiKeyService] Failed to read usage report – returning zeroed snapshot',
        {
          key,
          httpKey,
          wsKey,
          error: (err as any)?.message ?? err,
        },
      );
      return {
        httpRequestsThisMinute: 0,
        currentWsConnections: 0,
      };
    }
  }

  // Simple per-event rate limiter (RPS) using 1-second buckets in Redis
  // Returns null if allowed; otherwise returns { retry_after_ms }
  async checkWsRateLimit(
    socketId: string,
    event: string,
    rpsLimit: number,
  ): Promise<{ retry_after_ms: number } | null> {
    if (!rpsLimit || rpsLimit <= 0) return null;
    const now = Math.floor(Date.now() / 1000);
    const bucketKey = `ws:rate:${socketId}:${event}:${now}`;
    const count = await this.redisService.incr(bucketKey);
    if (count === 1) {
      await this.redisService.expire(bucketKey, 2);
    }
    if (count > rpsLimit) {
      const retry_after_ms = 1000 - (Date.now() % 1000);
      return { retry_after_ms };
    }
    return null;
  }

  private buildMinuteBucketKey(prefix: string, key: string): string {
    const now = new Date();
    const minute = `${now.getUTCFullYear()}${now.getUTCMonth()}${now.getUTCDate()}${now.getUTCHours()}${now.getUTCMinutes()}`;
    return `${prefix}:ratelimit:${key}:${minute}`;
  }
}
