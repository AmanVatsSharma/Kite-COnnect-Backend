/**
 * @file news-scheduler.service.ts
 * @module news
 * @description Polls Finnhub for fresh news every NEWS_POLL_INTERVAL_MS, persists, and broadcasts to WS clients.
 *
 * Exports:
 *   - NewsSchedulerService — interval-driven poller (OnModuleInit/OnModuleDestroy)
 *
 * Depends on:
 *   - NewsService — fetch + persist
 *   - NewsGateway — WS broadcast (lazy-resolved via ModuleRef to avoid circular dep)
 *
 * Side-effects:
 *   - setInterval polling loop
 *   - HTTP calls to Finnhub (via NewsService)
 *   - DB inserts (via NewsService)
 *   - WS emit to `news-room` (via NewsGateway)
 *
 * Key invariants:
 *   - Polls across multiple categories: general, forex, crypto, commodity
 *   - Deduplicates by finnhubId — only broadcasts news IDs not seen in last hour
 *   - Distributed lock via Redis ensures only ONE instance polls at a time
 */
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { RedisService } from '@infra/redis/redis.service';
import { NewsService, FinnhubNewsRaw } from './news.service';
import { NewsGateway } from '../interface/news.gateway';

const CATEGORIES = ['general', 'forex', 'crypto', 'commodity'] as const;

@Injectable()
export class NewsSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NewsSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs: number;
  private readonly enabled: boolean;
  private readonly seenIdsKey = 'news:seen_finnhub_ids';
  private readonly distributedLockKey = 'news:poll:lock';

  constructor(
    private readonly config: ConfigService,
    private readonly newsService: NewsService,
    private readonly redis: RedisService,
    private readonly moduleRef: ModuleRef,
  ) {
    this.pollIntervalMs = this.config.get<number>('NEWS_POLL_INTERVAL_MS', 300_000);
    this.enabled =
      String(this.config.get<string>('NEWS_POLLING_ENABLED', 'true')).toLowerCase() !==
      'false';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('[NewsScheduler] disabled by NEWS_POLLING_ENABLED=false');
      return;
    }

    const apiKey = this.config.get<string>('FINNHUB_API_KEY', '');
    if (!apiKey) {
      this.logger.warn('[NewsScheduler] FINNHUB_API_KEY not set — scheduler will idle');
      return;
    }

    this.logger.log(
      `[NewsScheduler] starting poll loop, interval=${this.pollIntervalMs}ms, categories=[${CATEGORIES.join(',')}]`,
    );

    // Immediate first run (delayed slightly to allow other modules to initialise)
    setTimeout(() => this.pollOnce().catch(() => {}), 5_000);

    this.timer = setInterval(() => {
      this.pollOnce().catch((err) =>
        this.logger.error(`[NewsScheduler] poll error: ${(err as any)?.message}`),
      );
    }, this.pollIntervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.log('[NewsScheduler] stopped');
  }

  /**
   * Single poll cycle:
   * 1. Acquire distributed lock to avoid duplicate polls across instances
   * 2. Fetch each category
   * 3. Persist to DB
   * 4. Dedupe + push to Redis ring buffer + broadcast over WS
   */
  async pollOnce(): Promise<void> {
    // Distributed lock — only one instance polls per interval window
    const lockTtlMs = Math.max(30_000, this.pollIntervalMs - 5_000);
    const acquired = await this.redis
      .tryAcquireLock(this.distributedLockKey, lockTtlMs)
      .catch(() => true); // fail-open

    if (!acquired) {
      this.logger.debug('[NewsScheduler] another instance holds the poll lock, skipping');
      return;
    }

    let totalNew = 0;
    for (const category of CATEGORIES) {
      try {
        const items = await this.newsService.fetchFromFinnhub(category);
        if (!items?.length) continue;

        const saved = await this.newsService.persistNewsItems(items);
        this.logger.debug(`[NewsScheduler] category=${category} persisted=${saved}`);

        const fresh = await this.filterNew(items);
        for (const item of fresh) {
          await this.newsService.pushToRingBuffer(item);
          this.broadcastWs(item);
        }
        totalNew += fresh.length;
      } catch (err) {
        this.logger.error(
          `[NewsScheduler] category=${category} failed: ${(err as any)?.message}`,
        );
      }
    }

    if (totalNew > 0) {
      this.logger.log(`[NewsScheduler] poll cycle complete, new items broadcast: ${totalNew}`);
    }
  }

  /**
   * Filter to only items whose finnhubId was NOT seen in the last hour.
   * Uses Redis SET-based dedupe (via HSET key → 1, TTL 1h).
   */
  private async filterNew(items: FinnhubNewsRaw[]): Promise<FinnhubNewsRaw[]> {
    const fresh: FinnhubNewsRaw[] = [];
    for (const item of items) {
      if (!item?.id) continue;
      try {
        const exists = await this.redis.exists(`${this.seenIdsKey}:${item.id}`);
        if (!exists) {
          await this.redis.set(`${this.seenIdsKey}:${item.id}`, 1, 3600);
          fresh.push(item);
        }
      } catch {
        // If Redis fails, treat as new (fail-open) to avoid silent data drop
        fresh.push(item);
      }
    }
    return fresh;
  }

  /**
   * Broadcast a news item over the news WebSocket gateway.
   * Resolved lazily via ModuleRef to avoid initial DI circular ref.
   */
  private broadcastWs(item: FinnhubNewsRaw): void {
    try {
      const gateway = this.moduleRef.get(NewsGateway, { strict: false });
      if (gateway?.broadcastNews) {
        gateway.broadcastNews(item);
      }
    } catch (err) {
      this.logger.debug(`[NewsScheduler] WS broadcast skipped: ${(err as any)?.message}`);
    }
  }
}