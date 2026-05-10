import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { ApiKey } from '@features/auth/domain/api-key.entity';
import { RedisService } from '@infra/redis/redis.service';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    @InjectRepository(ApiKey) private apiKeyRepo: Repository<ApiKey>,
    private redisService: RedisService,
  ) {}

  async validateApiKey(key: string): Promise<ApiKey | null> {
    const record = await this.apiKeyRepo.findOne({
      where: { key, is_active: true },
    });

    if (record && record.is_test && record.expires_at) {
      const now = new Date();
      if (now > record.expires_at) {
        throw new ForbiddenException(
          'Your trial period has expired. To continue using our services, please subscribe to a professional plan.',
        );
      }
    }

    return record || null;
  }

  /**
   * Automatically deletes test API keys that have been expired for more than 30 days.
   * Runs daily at midnight.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupExpiredTestKeys() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    this.logger.log('Starting cleanup of old expired test API keys...');

    try {
      const result = await this.apiKeyRepo.delete({
        is_test: true,
        expires_at: LessThan(thirtyDaysAgo),
      });

      this.logger.log(
        `Cleanup completed. Deleted ${result.affected || 0} expired test keys.`,
      );
    } catch (err) {
      this.logger.error('Failed to cleanup expired test keys', err as any);
    }
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
      const current = (await this.redisService.get<number>(bucketKey)) || 0;

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

  async incrementBytesSent(key: string, bytes: number): Promise<void> {
    if (bytes <= 0) return;
    const redisKey = this.buildDailyBytesKey(key);
    try {
      const newVal = await this.redisService.incrby(redisKey, bytes);
      if (newVal <= bytes) {
        // First write today — set 25h TTL so yesterday's key lives long enough for getBytesLast24h
        await this.redisService.expire(redisKey, 90_000);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ApiKeyService] Failed to increment bytes sent', {
        key,
        bytes,
        err: (err as any)?.message,
      });
    }
  }

  async getBytesLast24h(key: string): Promise<number> {
    try {
      const today = this.buildDailyBytesKey(key);
      const yesterday = this.buildDailyBytesKey(key, -1);
      const [a, b] = await Promise.all([
        this.redisService.get<number>(today),
        this.redisService.get<number>(yesterday),
      ]);
      return (a || 0) + (b || 0);
    } catch {
      return 0;
    }
  }

  async getMultiBytesLast24h(keys: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (keys.length === 0) return result;
    try {
      const counts = await Promise.all(
        keys.map((k) => this.getBytesLast24h(k)),
      );
      keys.forEach((k, i) => result.set(k, counts[i] ?? 0));
    } catch {
      keys.forEach((k) => result.set(k, 0));
    }
    return result;
  }

  private buildDailyBytesKey(key: string, dayOffset = 0): string {
    const d = new Date();
    if (dayOffset !== 0) d.setDate(d.getDate() + dayOffset);
    const tag = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    return `ws:bytes:${key}:${tag}`;
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

  // Simple per-event rate limiter (RPS) using 1-second buckets in Redis.
  // - Scope is per logical owner (API key), not per socket.
  // - Returns null if allowed; otherwise returns { retry_after_ms }.
  async checkWsRateLimit(
    scopeId: string,
    event: string,
    rpsLimit: number,
  ): Promise<{ retry_after_ms: number } | null> {
    if (!rpsLimit || rpsLimit <= 0) return null;
    if (!scopeId) return null;

    const now = Math.floor(Date.now() / 1000);
    const bucketKey = `ws:rate:${scopeId}:${event}:${now}`;

    try {
      const count = await this.redisService.incr(bucketKey);
      if (count === 1) {
        await this.redisService.expire(bucketKey, 2);
      }
      if (count > rpsLimit) {
        const retry_after_ms = 1000 - (Date.now() % 1000);
        // eslint-disable-next-line no-console
        console.log(
          '[ApiKeyService] WS rate limit exceeded',
          JSON.stringify({
            scopeId,
            event,
            rpsLimit,
            bucketKey,
            count,
            retry_after_ms,
          }),
        );
        return { retry_after_ms };
      }
      return null;
    } catch (err) {
      // Infra failure – do not block the WS event; just log.
      // eslint-disable-next-line no-console
      console.error(
        '[ApiKeyService] Failed to evaluate WS rate limit – continuing without throttling',
        {
          scopeId,
          event,
          rpsLimit,
          bucketKey,
          error: (err as any)?.message ?? err,
        },
      );
      return null;
    }
  }

  /**
   * Notify the system (specifically WebSocket gateways) that an API key's
   * configuration (limits, entitlements) has changed.
   * Uses Redis Pub/Sub to broadcast the update to all instances.
   */
  async notifyApiKeyUpdate(key: string): Promise<void> {
    try {
      await this.redisService.publish(
        'api_key_updates',
        JSON.stringify({ key }),
      );
      // eslint-disable-next-line no-console
      console.log(
        `[ApiKeyService] Published update notification for key=${key}`,
      );
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        '[ApiKeyService] Failed to publish API key update notification',
        error,
      );
    }
  }

  private buildMinuteBucketKey(prefix: string, key: string): string {
    const now = new Date();
    const minute = `${now.getUTCFullYear()}${now.getUTCMonth()}${now.getUTCDate()}${now.getUTCHours()}${now.getUTCMinutes()}`;
    return `${prefix}:ratelimit:${key}:${minute}`;
  }
}
