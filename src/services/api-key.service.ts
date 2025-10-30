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

  private buildMinuteBucketKey(prefix: string, key: string): string {
    const now = new Date();
    const minute = `${now.getUTCFullYear()}${now.getUTCMonth()}${now.getUTCDate()}${now.getUTCHours()}${now.getUTCMinutes()}`;
    return `${prefix}:ratelimit:${key}:${minute}`;
  }
}
