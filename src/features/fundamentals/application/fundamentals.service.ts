/**
 * @file fundamentals.service.ts
 * @module fundamentals
 * @description Caching service for stock fundamental data. Checks Postgres cache first,
 *              falls back to FundamentalsFetchService (Yahoo Finance). Background refresh
 *              on stale cache. Max 5 symbols per batch, 500ms inter-request delay.
 *
 * Exports:
 *   - FundamentalsService                    — cache-aware fundamentals fetch + background refresh
 *   - GetFundamentalsResult                 — response shape with dataStale flag
 *
 * Depends on:
 *   - FundamentalsCache entity              — Postgres cache table
 *   - FundamentalsFetchService             — raw Yahoo Finance fetcher
 *   - @infra/redis/redis.service           — RedisService for shared cache key (optional)
 *   - @nestjs/config                       — ConfigService for FUNDAMENTALS_CACHE_TTL_HOURS
 *   - @nestjs/typeorm                      — Repository<FundamentalsCache>
 *
 * Side-effects:
 *   - DB reads/writes to fundamentals_cache table
 *   - HTTP calls to Yahoo Finance when cache miss or stale
 *   - Redis writes for distributed short-term cache
 *
 * Key invariants:
 *   - Stale cache is served immediately; refresh happens in background (fire-and-forget)
 *   - nextFetchAt > now = fresh; nextFetchAt <= now = stale (still served, flagged)
 *   - symbol+exchange is unique; upsert on write
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { FundamentalsCache } from '../domain/entities/fundamentals-cache.entity';
import { FundamentalsFetchService } from './fundamentals-fetch.service';
import { RedisService } from '@infra/redis/redis.service';

export interface GetFundamentalsResult {
  success: boolean;
  dataStale?: boolean;
  source: 'cache' | 'fresh' | 'stale';
  data: any;
  fetchedAt?: string;
}

const BATCH_MAX = 5;
const REQUEST_DELAY_MS = 500;

@Injectable()
export class FundamentalsService {
  private readonly logger = new Logger(FundamentalsService.name);

  /** Cache TTL in hours, default 24 */
  private readonly cacheTtlHours: number;

  constructor(
    @InjectRepository(FundamentalsCache)
    private readonly cacheRepo: Repository<FundamentalsCache>,
    private readonly fetchService: FundamentalsFetchService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.cacheTtlHours = Number(
      this.config.get<number>('FUNDAMENTALS_CACHE_TTL_HOURS', 24),
    );
  }

  /**
   * Get fundamentals for a single symbol.
   * Returns cached data immediately if available; fetches fresh if missing or stale.
   * Stale cache is returned with dataStale=true and refresh runs in background.
   */
  async getFundamentals(
    symbol: string,
    exchange: string = 'NSE',
  ): Promise<GetFundamentalsResult> {
    const sym = (symbol || '').trim().toUpperCase();
    const ex = (exchange || 'NSE').toUpperCase();
    if (!sym) {
      return { success: false, data: { error: 'Symbol required' }, source: 'cache' };
    }

    // Check Postgres cache
    const cached = await this.cacheRepo.findOne({
      where: { symbol: sym, exchange: ex },
    });

    const now = new Date();

    if (cached && cached.nextFetchAt > now) {
      // Fresh cache
      return {
        success: true,
        data: cached.data,
        source: 'cache',
        fetchedAt: cached.fetchedAt?.toISOString(),
      };
    }

    if (cached && cached.nextFetchAt <= now) {
      // Stale cache — serve immediately, refresh in background
      this.logger.log(
        `[FundamentalsService] Stale cache for ${sym}, serving stale and refreshing in background`,
      );
      setImmediate(() => {
        void this.refreshFundamentals(sym, ex).catch((e) =>
          this.logger.warn(
            `[FundamentalsService] Background refresh failed for ${sym}: ${e.message}`,
          ),
        );
      });
      return {
        success: true,
        dataStale: true,
        data: cached.data,
        source: 'stale',
        fetchedAt: cached.fetchedAt?.toISOString(),
      };
    }

    // No cache — fetch fresh
    const data = await this.fetchService.fetchFundamentals(sym, ex);
    if (!data) {
      return {
        success: false,
        data: { error: `Failed to fetch fundamentals for ${sym}` },
        source: 'fresh',
      };
    }

    // Cache the result
    await this.upsertCache(sym, ex, data);

    return {
      success: true,
      data,
      source: 'fresh',
      fetchedAt: data.fetchedAt,
    };
  }

  /**
   * Batch get fundamentals for multiple symbols.
   * Max 5 symbols, with 500ms delay between requests.
   */
  async getFundamentalsBatch(
    symbols: string[],
    exchange: string = 'NSE',
  ): Promise<GetFundamentalsResult[]> {
    const ex = (exchange || 'NSE').toUpperCase();
    const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].slice(
      0,
      BATCH_MAX,
    );

    const results: GetFundamentalsResult[] = [];
    for (const sym of unique) {
      const result = await this.getFundamentals(sym, ex);
      results.push(result);
      if (sym !== unique[unique.length - 1]) {
        await this.delay(REQUEST_DELAY_MS);
      }
    }
    return results;
  }

  /**
   * Force-refresh fundamentals for a symbol — bypasses cache TTL check.
   */
  async refreshFundamentals(
    symbol: string,
    exchange: string = 'NSE',
  ): Promise<GetFundamentalsResult> {
    const sym = (symbol || '').trim().toUpperCase();
    const ex = (exchange || 'NSE').toUpperCase();

    const data = await this.fetchService.fetchFundamentals(sym, ex);
    if (!data) {
      return {
        success: false,
        data: { error: `Failed to fetch fundamentals for ${sym}` },
        source: 'fresh',
      };
    }

    await this.upsertCache(sym, ex, data);

    return {
      success: true,
      data,
      source: 'fresh',
      fetchedAt: data.fetchedAt,
    };
  }

  /**
   * Clear cache for a symbol (or all if no symbol provided).
   */
  async clearCache(symbol?: string, exchange?: string): Promise<{ cleared: number }> {
    if (symbol && exchange) {
      const result = await this.cacheRepo.delete({
        symbol: symbol.toUpperCase(),
        exchange: exchange.toUpperCase(),
      });
      return { cleared: result.affected ?? 0 };
    }

    // Clear all
    const result = await this.cacheRepo.delete({});
    return { cleared: result.affected ?? 0 };
  }

  /**
   * Stats about the cache.
   */
  async getCacheStats(): Promise<{
    total: number;
    fresh: number;
    stale: number;
    byExchange: Record<string, number>;
  }> {
    const all = await this.cacheRepo.find();
    const now = new Date();
    const fresh = all.filter((r) => r.nextFetchAt > now).length;
    const stale = all.filter((r) => r.nextFetchAt <= now).length;
    const byExchange: Record<string, number> = {};
    for (const r of all) {
      byExchange[r.exchange] = (byExchange[r.exchange] ?? 0) + 1;
    }
    return { total: all.length, fresh, stale, byExchange };
  }

  private async upsertCache(
    symbol: string,
    exchange: string,
    data: any,
  ): Promise<void> {
    const now = new Date();
    const nextFetchAt = new Date(now.getTime() + this.cacheTtlHours * 3600 * 1000);

    try {
      await this.cacheRepo.upsert(
        {
          symbol,
          exchange,
          fetchedAt: new Date(),
          nextFetchAt,
          data,
          stale: false,
        },
        {
          conflictPaths: ['symbol', 'exchange'],
          skipUpdateIfNoValuesChanged: false,
        },
      );
    } catch (e) {
      this.logger.warn(
        `[FundamentalsService] Cache upsert failed for ${symbol}: ${(e as Error).message}`,
      );
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}