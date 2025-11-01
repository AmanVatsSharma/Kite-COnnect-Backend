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
    const bucketKey = this.buildMinuteBucketKey('http', key);
    const current = (await this.redisService.get<number>(bucketKey)) || 0;
    if (current >= limitPerMinute) {
      throw new Error('Rate limit exceeded');
    }
    await this.redisService.set(bucketKey, current + 1, 65);
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
    const [httpCount, wsCount] = await Promise.all([
      this.redisService.get<number>(httpKey),
      this.redisService.get<number>(wsKey),
    ]);
    return {
      httpRequestsThisMinute: httpCount || 0,
      currentWsConnections: wsCount || 0,
    };
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
