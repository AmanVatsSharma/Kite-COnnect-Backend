/**
 * @file app-config.service.ts
 * @module infra/app-config
 * @description DB-backed key-value config service for runtime operator settings.
 *   DB is the source of truth; Redis is used as a short-lived read cache (5 min TTL)
 *   to avoid hitting Postgres on every hot-path credential lookup.
 * @author BharatERP
 * @created 2026-04-14
 * @updated 2026-04-14
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppConfig } from './app-config.entity';
import { RedisService } from '@infra/redis/redis.service';

const REDIS_TTL = 300; // 5 min cache on top of DB

@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);

  constructor(
    @InjectRepository(AppConfig)
    private readonly repo: Repository<AppConfig>,
    private readonly redis: RedisService,
  ) {}

  /** Get a config value. Checks Redis cache first, then DB, then returns null. */
  async get(key: string): Promise<string | null> {
    // 1. Redis cache
    if (this.redis?.isRedisAvailable?.()) {
      try {
        const cached = await this.redis.get<string>(`appconfig:${key}`);
        if (cached !== null && cached !== undefined) return cached;
      } catch {}
    }
    // 2. DB
    try {
      const row = await this.repo.findOne({ where: { key } });
      if (row) {
        // Warm the cache
        if (this.redis?.isRedisAvailable?.()) {
          try {
            await this.redis.set(`appconfig:${key}`, row.value, REDIS_TTL);
          } catch {}
        }
        return row.value;
      }
    } catch (error) {
      this.logger.warn(
        `[AppConfig] DB read failed for key "${key}"`,
        error as any,
      );
    }
    return null;
  }

  /** Set a config value in DB (upsert) and invalidate the Redis cache entry. */
  async set(key: string, value: string): Promise<void> {
    try {
      await this.repo.upsert({ key, value }, ['key']);
      // Invalidate cache so next read reflects the new value
      if (this.redis?.isRedisAvailable?.()) {
        try {
          await this.redis.del(`appconfig:${key}`);
        } catch {}
      }
    } catch (error) {
      this.logger.error(
        `[AppConfig] DB write failed for key "${key}"`,
        error as any,
      );
      throw error;
    }
  }

  /** Delete a config key from DB and cache. */
  async del(key: string): Promise<void> {
    try {
      await this.repo.delete({ key });
      if (this.redis?.isRedisAvailable?.()) {
        try {
          await this.redis.del(`appconfig:${key}`);
        } catch {}
      }
    } catch (error) {
      this.logger.warn(
        `[AppConfig] DB delete failed for key "${key}"`,
        error as any,
      );
    }
  }
}
