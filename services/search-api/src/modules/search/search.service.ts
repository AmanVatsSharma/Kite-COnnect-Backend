import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import Redis from 'ioredis';

type SearchResultItem = {
  instrumentToken: number;
  symbol: string;
  tradingSymbol?: string;
  companyName?: string;
  exchange?: string;
  segment?: string;
  instrumentType?: string;
};

@Injectable()
export class SearchService {
  private readonly logger = new Logger('SearchService');
  private readonly meili: AxiosInstance;
  private readonly hydrator: AxiosInstance;
  private readonly redis?: Redis;
  private hydrationFailures = 0;
  private hydrationBreakerUntil = 0;

  constructor() {
    const meiliHost = process.env.MEILI_HOST || 'http://meilisearch:7700';
    const meiliKey = process.env.MEILI_MASTER_KEY || '';
    const hydrateBase =
      process.env.HYDRATION_BASE_URL || 'http://trading-app:3000';
    const redisHost = process.env.REDIS_HOST || 'redis';
    const redisPort = Number(process.env.REDIS_PORT || 6379);

    this.meili = axios.create({
      baseURL: meiliHost,
      headers: meiliKey ? { Authorization: `Bearer ${meiliKey}` } : {},
      timeout: Number(process.env.MEILI_TIMEOUT_MS || 1200),
    });

    this.hydrator = axios.create({
      baseURL: hydrateBase,
      timeout: Number(process.env.HYDRATE_TIMEOUT_MS || 1500),
    });

    // Console logs for runtime visibility
    // eslint-disable-next-line no-console
    console.log('SearchService meiliHost=', meiliHost);
    // eslint-disable-next-line no-console
    console.log('SearchService hydrateBase=', hydrateBase);

    try {
      this.redis = new Redis({ host: redisHost, port: redisPort, lazyConnect: true });
      // Lazy connect on first use
    } catch (err) {
      this.logger.warn('Redis not initialized, continuing without cache');
    }
  }

  // Starts-with boosted search then contains fallback; returns deduped list
  async searchInstruments(q: string, limit = 10, filters: any = {}) {
    const index = process.env.MEILI_INDEX || 'instruments_v1';
    const attributesToRetrieve = ['instrumentToken', 'symbol', 'tradingSymbol', 'companyName', 'exchange', 'segment', 'instrumentType'];
    const filterExpr = this.buildFilter(filters);

    const startsWith = await this.meili.post(`/indexes/${index}/search`, {
      q,
      limit,
      attributesToRetrieve,
      filter: filterExpr,
      matchingStrategy: 'all',
    });

    // If enough, return
    const primary: SearchResultItem[] = startsWith.data.hits || [];
    if (primary.length >= limit) return primary.slice(0, limit);

    // Fallback broader search (contains)
    const contains = await this.meili.post(`/indexes/${index}/search`, {
      q,
      limit,
      attributesToRetrieve,
      filter: filterExpr,
      matchingStrategy: 'last',
    });

    const merged = this.dedupeByToken([...primary, ...(contains.data.hits || [])]);
    return merged.slice(0, limit);
  }

  async facetCounts(filters: any = {}) {
    const index = process.env.MEILI_INDEX || 'instruments_v1';
    const filterExpr = this.buildFilter(filters);
    const facets = ['exchange', 'segment', 'instrumentType', 'expiryDate'];
    const resp = await this.meili.post(`/indexes/${index}/search`, {
      q: '',
      limit: 0,
      filter: filterExpr,
      facets,
    });
    return resp.data?.facetDistribution || {};
  }

  async hydrateQuotes(tokens: number[], mode: 'ltp' | 'ohlc' | 'full' = 'ltp') {
    if (!tokens.length) return {};
    const now = Date.now();
    if (now < this.hydrationBreakerUntil) {
      this.logger.warn('Hydration circuit breaker open, skipping external calls');
      return {};
    }
    const cacheTTL = Number(process.env.HYDRATE_TTL_MS || 800);
    const cacheKey = (t: number) => `q:${mode}:${t}`;
    const result: Record<string, any> = {};
    const toFetch: number[] = [];

    // Try cache first
    if (this.redis) {
      for (const t of tokens) {
        const v = await this.redis.get(cacheKey(t));
        if (v) {
          result[String(t)] = JSON.parse(v);
        } else {
          toFetch.push(t);
        }
      }
    } else {
      toFetch.push(...tokens);
    }

    if (toFetch.length) {
      try {
        const url = `/api/stock/quotes?mode=${mode}&ltp_only=true`;
        const resp = await this.hydrator.post(url, { instruments: toFetch });
        const data = resp.data?.data || {};
        Object.assign(result, data);
        if (this.redis) {
          for (const [k, v] of Object.entries(data)) {
            await this.redis.setex(
              cacheKey(Number(k)),
              Math.ceil(cacheTTL / 1000),
              JSON.stringify(v),
            );
          }
        }
        // success: reset breaker
        this.hydrationFailures = 0;
        this.hydrationBreakerUntil = 0;
      } catch (err: any) {
        this.hydrationFailures += 1;
        const openAfter = Number(process.env.HYDRATE_CB_THRESHOLD || 3);
        const openForMs = Number(process.env.HYDRATE_CB_OPEN_MS || 2000);
        if (this.hydrationFailures >= openAfter) {
          this.hydrationBreakerUntil = Date.now() + openForMs;
          this.logger.warn(
            `Hydration failed ${this.hydrationFailures}x, opening circuit for ${openForMs}ms`,
          );
          this.hydrationFailures = 0;
        } else {
          this.logger.warn(`Hydration fallback failed: ${err?.message}`);
        }
      }
    }
    return result;
  }

  private buildFilter(filters: any): string | undefined {
    const parts: string[] = [];
    if (!filters) return undefined;
    if (filters.exchange) parts.push(`exchange = ${JSON.stringify(filters.exchange)}`);
    if (filters.segment) parts.push(`segment = ${JSON.stringify(filters.segment)}`);
    if (filters.instrumentType) parts.push(`instrumentType = ${JSON.stringify(filters.instrumentType)}`);
    return parts.length ? parts.join(' AND ') : undefined;
  }

  private dedupeByToken(items: SearchResultItem[]): SearchResultItem[] {
    const seen = new Set<number>();
    const out: SearchResultItem[] = [];
    for (const it of items) {
      if (!seen.has(it.instrumentToken)) {
        seen.add(it.instrumentToken);
        out.push(it);
      }
    }
    return out;
  }
}


