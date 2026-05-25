/**
 * @file news.service.ts
 * @module news
 * @description Finnhub news fetcher with Redis caching, retry, and database persistence.
 *
 * Exports:
 *   - NewsService                          — fetch, list, getById
 *   - FinnhubNewsRaw                        — raw Finnhub API shape
 *
 * Depends on:
 *   - @infra/redis/RedisService            — cache + ring-buffer store
 *   - @nestjs/typeorm / NewsItem repo      — persistence
 *   - axios                                — HTTP client with retry
 *
 * Side-effects:
 *   - Reads/writes Redis (cache + news:items ring buffer)
 *   - Writes to news_items Postgres table
 *   - HTTP GET to finnhub.io
 *
 * Key invariants:
 *   - FINNHUB_API_KEY env var must be set; returns cached/empty on failure
 *   - Related symbols parsed from Finnhub's comma-separated `related` field
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import axios from 'axios';
import { RedisService } from '@infra/redis/redis.service';
import { NewsItem } from '../domain/news-item.entity';
import {
  NewsListQueryDto,
  NewsCategory,
  NewsItemResponseDto,
} from '../dto/news.dto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FinnhubNewsRaw {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
}

// ─── NewsService ─────────────────────────────────────────────────────────────

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);
  private readonly apiKey: string;
  private readonly cacheTtlSecs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    @InjectRepository(NewsItem)
    private readonly newsRepo: Repository<NewsItem>,
  ) {
    this.apiKey =
      this.config.get<string>('FINNHUB_API_KEY', '') || '';
    this.cacheTtlSecs = this.config.get<number>('NEWS_CACHE_TTL_SECONDS', 300);
    this.pollIntervalMs = this.config.get<number>('NEWS_POLL_INTERVAL_MS', 300_000);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * List news items with optional category/symbol filter and pagination.
   * Reads from Postgres; falls back to Redis cache when DB is unavailable.
   */
  async list(query: NewsListQueryDto): Promise<{
    items: NewsItemResponseDto[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    try {
      const qb = this.newsRepo.createQueryBuilder('n');

      if (query.category) {
        qb.andWhere('n.category = :category', { category: query.category });
      }

      if (query.symbol) {
        qb.andWhere('n.relatedSymbolsRaw ILIKE :symbol', {
          symbol: `%${query.symbol}%`,
        });
      }

      qb.orderBy('n.publishedAt', 'DESC')
        .skip(skip)
        .take(limit);

      const [entities, total] = await qb.getManyAndCount();

      return {
        items: entities.map(toResponseDto),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (err) {
      this.logger.warn(`News list DB query failed, falling back to cache: ${(err as any)?.message}`);
      return this.listFromCache(page, limit);
    }
  }

  /**
   * Get a single news item by UUID.
   */
  async getById(id: string): Promise<NewsItem | null> {
    try {
      return await this.newsRepo.findOne({ where: { id } });
    } catch (err) {
      this.logger.warn(`News getById DB failed, trying cache: ${(err as any)?.message}`);
      const cached = await this.redis.get<NewsItem>(`news:item:${id}`);
      return cached;
    }
  }

  /**
   * Fetch fresh news from Finnhub for a given category.
   * Caches result in Redis and returns raw Finnhub items.
   * Returns empty array if API key is not configured.
   */
  async fetchFromFinnhub(category: string = 'general'): Promise<FinnhubNewsRaw[]> {
    if (!this.apiKey) {
      this.logger.warn('[NewsService] FINNHUB_API_KEY not configured — skipping fetch');
      return [];
    }

    const cacheKey = `news:finnhub:${category}`;
    const cached = await this.redis.get<FinnhubNewsRaw[]>(cacheKey);
    if (cached) {
      this.logger.debug(`[NewsService] Finnhub cache HIT for category=${category}`);
      return cached;
    }

    try {
      const items = await this.fetchWithRetry(
        `https://finnhub.io/api/v1/news?category=${category}&token=${this.apiKey}`,
      );

      if (Array.isArray(items) && items.length > 0) {
        await this.redis.set(cacheKey, items, this.cacheTtlSecs);
        this.logger.log(`[NewsService] Fetched ${items.length} items from Finnhub (category=${category})`);
      }

      return items as FinnhubNewsRaw[];
    } catch (err) {
      this.logger.error(`[NewsService] Finnhub fetch failed: ${(err as any)?.message}`);
      return [];
    }
  }

  /**
   * Persist an array of raw Finnhub items into the database.
   * Upserts by finnhubId so re-fetching the same news does not create duplicates.
   * Returns the number of items saved.
   */
  async persistNewsItems(rawItems: FinnhubNewsRaw[]): Promise<number> {
    if (!rawItems?.length) return 0;

    const entities = rawItems.map((item) => this.toEntity(item));
    try {
      await this.newsRepo
        .createQueryBuilder()
        .insert()
        .into(NewsItem)
        .values(entities)
        .orUpdate(
          ['headline', 'summary', 'source', 'category', 'url', 'imageUrl', 'publishedAt', 'relatedSymbolsRaw', 'relatedSymbols'],
          ['finnhubId'],
        )
        .execute();
      return entities.length;
    } catch (err) {
      this.logger.error(`[NewsService] persistNewsItems failed: ${(err as any)?.message}`);
      return 0;
    }
  }

  /**
   * Push a news item to the Redis ring buffer (news:items).
   * Keeps the latest 100 entries. Called by the scheduler after each fetch.
   */
  async pushToRingBuffer(rawItem: FinnhubNewsRaw): Promise<void> {
    try {
      const dto = this.toResponseDto(rawItem);
      await this.redis.lpushTrim('news:items', JSON.stringify(dto), 100);
    } catch (err) {
      this.logger.warn(`[NewsService] pushToRingBuffer failed: ${(err as any)?.message}`);
    }
  }

  /**
   * Get the latest N items from the Redis ring buffer.
   */
  async getLatestFromCache(count = 20): Promise<NewsItemResponseDto[]> {
    try {
      const raw = await this.redis.lrangeRaw('news:items', 0, count - 1);
      return raw
        .map((s) => {
          try { return JSON.parse(s) as NewsItemResponseDto; }
          catch { return null; }
        })
        .filter(Boolean) as NewsItemResponseDto[];
    } catch {
      return [];
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async listFromCache(page: number, limit: number): Promise<{
    items: NewsItemResponseDto[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const raw = await this.redis.lrangeRaw('news:items', 0, 999);
    const all = raw
      .map((s) => { try { return JSON.parse(s) as NewsItemResponseDto; } catch { return null; } })
      .filter(Boolean) as NewsItemResponseDto[];
    const total = all.length;
    const start = (page - 1) * limit;
    const items = all.slice(start, start + limit);
    return {
      items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  private async fetchWithRetry(
    url: string,
    retries = 3,
    backoffMs = 500,
  ): Promise<any> {
    let lastError: any;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await axios.get(url, { timeout: 10_000 });
        return response.data;
      } catch (err) {
        lastError = err;
        this.logger.warn(
          `[NewsService] Finnhub request attempt ${attempt}/${retries} failed: ${(err as any)?.message}`,
        );
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, backoffMs * attempt));
        }
      }
    }
    throw lastError;
  }

  private toEntity(raw: FinnhubNewsRaw): Partial<NewsItem> {
    return {
      finnhubId: raw.id,
      source: raw.source || 'unknown',
      category: raw.category || 'general',
      headline: raw.headline || '',
      summary: raw.summary || null,
      url: raw.url || '',
      imageUrl: raw.image || null,
      publishedAt: raw.datetime ? new Date(raw.datetime * 1000) : new Date(),
      relatedSymbolsRaw: raw.related || null,
      relatedSymbols: raw.related
        ? raw.related.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
        : null,
    };
  }

  private toResponseDto(raw: FinnhubNewsRaw): NewsItemResponseDto {
    return {
      id: `fh-${raw.id}`,
      headline: raw.headline || '',
      summary: raw.summary || null,
      source: raw.source || 'unknown',
      url: raw.url || '',
      imageUrl: raw.image || null,
      publishedAt: raw.datetime ? new Date(raw.datetime * 1000).toISOString() : new Date().toISOString(),
      relatedSymbols: raw.related
        ? raw.related.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
        : null,
      category: raw.category || 'general',
    };
  }
}

function toResponseDto(entity: NewsItem): NewsItemResponseDto {
  return {
    id: entity.id,
    headline: entity.headline,
    summary: entity.summary,
    source: entity.source,
    url: entity.url,
    imageUrl: entity.imageUrl,
    publishedAt: entity.publishedAt?.toISOString() || new Date().toISOString(),
    relatedSymbols: entity.relatedSymbols,
    category: entity.category,
  };
}