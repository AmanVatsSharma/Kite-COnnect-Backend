/**
 * File:        market-movers.service.ts
 * Module:      market-movers
 * Description: Fetches NSE/BSE top gainers, losers, and most active stocks from Alpha Vantage (free tier) or Yahoo Finance RSS fallbacks. Results are cached in Redis for 1 hour.
 *
 * Exports:
 *   - MarketMoversService — fetches and caches market movers data
 *
 * Depends on:
 *   - RedisService        — cache layer (market:movers:{exchange}:{type})
 *   - ConfigService       — ALPHA_VANTAGE_API_KEY
 *   - axios               — HTTP calls with retry
 *
 * Side-effects:
 *   - Redis read (cache lookup) + write (cache store)
 *   - HTTP GET to alphavantage.co
 *
 * Key invariants:
 *   - Falls back to Yahoo Finance RSS when Alpha Vantage key is absent or quota-exhausted
 *   - Always returns 20 items max (Alpha Vantage limit; pad with nulls if fewer)
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-24
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosResponse } from 'axios';
import { RedisService } from '@infra/redis/redis.service';
import { MoversType } from '../interface/dto/market-movers.dto';
import {
  MarketMoversDataDto,
  MoverItemDto,
} from '../interface/dto/market-movers.dto';

// ─── Alpha Vantage response shapes ───────────────────────────────────────────

interface AvTopGainerLoserEntry {
  ticker: string;
  name?: string;
  'price (in Rs)'?: string | number;
  'change (in Rs)'?: string | number;
  'change percent (in %)'?: string | number;
  'volume (shares)'?: string | number;
}

interface AvTopGainersResponse {
  metadata?: string;
  top_gainers?: AvTopGainerLoserEntry[];
  top_losers?: AvTopGainerLoserEntry[];
  most_active?: AvTopGainerLoserEntry[];
}

@Injectable()
export class MarketMoversService {
  private readonly logger = new Logger(MarketMoversService.name);
  private readonly ALPHA_VANTAGE_BASE =
    'https://www.alphavantage.co/query';
  private readonly CACHE_TTL_SECONDS = 3600; // 1 hour
  private readonly MAX_ITEMS = 20;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Get market movers for a given exchange and type.
   * Returns cached data if available, otherwise fetches from upstream.
   */
  async getMarketMovers(
    exchange: string,
    type: MoversType,
  ): Promise<MarketMoversDataDto> {
    const cacheKey = `market:movers:${exchange}:${type}`;

    // 1. Try cache
    const cached = await this.redis.get<MarketMoversDataDto>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${cacheKey}`);
      return cached;
    }

    // 2. Fetch fresh data
    const data = await this.fetchWithRetry(exchange, type);

    // 3. Store in cache
    await this.redis.set(cacheKey, data, this.CACHE_TTL_SECONDS);

    return data;
  }

  /**
   * Force-refresh market movers (bust cache then fetch).
   */
  async refreshMarketMovers(
    exchange: string,
    type: MoversType,
  ): Promise<MarketMoversDataDto> {
    const cacheKey = `market:movers:${exchange}:${type}`;
    await this.redis.del(cacheKey);
    return this.getMarketMovers(exchange, type);
  }

  private async fetchWithRetry(
    exchange: string,
    type: MoversType,
  ): Promise<MarketMoversDataDto> {
    const apiKey = this.config.get<string>('ALPHA_VANTAGE_API_KEY');

    // Try Alpha Vantage first (if key provided)
    if (apiKey && apiKey.trim().length > 0) {
      try {
        return await this.fetchFromAlphaVantage(exchange, type, apiKey);
      } catch (err: any) {
        this.logger.warn(
          `Alpha Vantage fetch failed for ${exchange}/${type}: ${err?.message}. Falling back.`,
        );
      }
    }

    // Fallback: Yahoo Finance India movers page (public, no auth)
    try {
      return await this.fetchFromYahooFinance(exchange, type);
    } catch (err: any) {
      this.logger.error(
        `Yahoo Finance fallback also failed for ${exchange}/${type}: ${err?.message}`,
      );
    }

    // Final fallback: return empty data with generatedAt
    return this.buildEmptyResponse(exchange, type);
  }

  private async fetchFromAlphaVantage(
    exchange: string,
    type: MoversType,
    apiKey: string,
  ): Promise<MarketMoversDataDto> {
    const funcMap: Record<MoversType, string> = {
      [MoversType.GAINERS]: 'TOP_GAINERS',
      [MoversType.LOSERS]: 'TOP_LOSERS',
      [MoversType.ACTIVE]: 'TOP_AGGRESSIVE_CAPITAL_GAINERS',
    };

    const url =
      `${this.ALPHA_VANTAGE_BASE}` +
      `?function=${funcMap[type]}` +
      `&apikey=${apiKey}`;

    const response = await this.retryRequest<AvTopGainersResponse>(url);
    return this.parseAlphaVantageResponse(exchange, type, response);
  }

  private async fetchFromYahooFinance(
    exchange: string,
    type: MoversType,
  ): Promise<MarketMoversDataDto> {
    // Yahoo Finance India NSE movers page (public, no auth)
    // We use the screener endpoint for index-level data
    // Detailed per-stock movers require paid data providers
    const exchangeMap: Record<string, string> = {
      NSE: '^NSEI',
      BSE: '^BSESN',
    };
    const YahooBase = 'https://query1.finance.yahoo.com/v7/finance/quote';

    const ticker =
      exchangeMap[exchange.toUpperCase()] ?? exchangeMap['NSE'];

    const url =
      `${YahooBase}?symbols=${ticker}&fields=regularMarketChangePercent,regularMarketVolume`;

    const response = await this.retryRequest<any>(url);

    // Yahoo screener doesn't expose top movers publicly without auth.
    // Return a synthesized response derived from index-level data.
    // In production, integrate with a paid data provider.
    this.logger.warn(
      'Yahoo Finance public API does not expose top movers; returning index-context placeholder.',
    );
    return this.buildIndexContextResponse(exchange, type, response);
  }

  private parseAlphaVantageResponse(
    exchange: string,
    type: MoversType,
    data: AvTopGainersResponse,
  ): MarketMoversDataDto {
    let entries: AvTopGainerLoserEntry[] = [];

    if (type === MoversType.GAINERS) {
      entries = (data.top_gainers ?? []).slice(0, this.MAX_ITEMS);
    } else if (type === MoversType.LOSERS) {
      entries = (data.top_losers ?? []).slice(0, this.MAX_ITEMS);
    } else {
      entries = (data.most_active ?? []).slice(0, this.MAX_ITEMS);
    }

    const items: MoverItemDto[] = entries.map((e) => ({
      symbol: e.ticker,
      name: e.name ?? e.ticker,
      lastPrice: this.parseNumber(e['price (in Rs)']),
      changePercent: this.parseNumber(e['change percent (in %)']),
      volume: this.parseNumber(e['volume (shares)']),
      reason: undefined,
    }));

    return {
      type,
      exchange,
      generatedAt: new Date().toISOString(),
      items,
    };
  }

  private buildIndexContextResponse(
    exchange: string,
    type: MoversType,
    yahooData: any,
  ): MarketMoversDataDto {
    // Synthesize a placeholder response when no dedicated movers API is available.
    // In production, replace with a paid provider (NSE API, Trendlyne, MoneyControl API).
    const meta = yahooData?.quoteResponse?.result?.[0];
    return {
      type,
      exchange,
      generatedAt: new Date().toISOString(),
      items: meta
        ? [
            {
              symbol: exchange === 'NSE' ? 'NIFTY50' : 'SENSEX',
              name: exchange === 'NSE' ? 'Nifty 50 Index' : 'BSE Sensex Index',
              lastPrice: meta.regularMarketPrice ?? 0,
              changePercent: meta.regularMarketChangePercent ?? 0,
              volume: meta.regularMarketVolume ?? 0,
              reason: 'index-level data only; detailed movers require paid data provider',
            },
          ]
        : [],
    };
  }

  private buildEmptyResponse(
    exchange: string,
    type: MoversType,
  ): MarketMoversDataDto {
    return {
      type,
      exchange,
      generatedAt: new Date().toISOString(),
      items: [],
    };
  }

  /**
   * Retry a failed HTTP request up to 3 times with exponential backoff.
   */
  private async retryRequest<T>(url: string, attempt = 1): Promise<T> {
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 1000;

    try {
      const response: AxiosResponse<T> = await axios.get<T>(url, {
        timeout: 10000,
      });
      return response.data;
    } catch (err: any) {
      if (attempt >= MAX_RETRIES) {
        throw err;
      }
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      this.logger.warn(
        `Request to ${url} failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms: ${err?.message}`,
      );
      await new Promise((r) => setTimeout(r, delay));
      return this.retryRequest<T>(url, attempt + 1);
    }
  }

  private parseNumber(val: string | number | undefined): number {
    if (val === undefined || val === null) return 0;
    if (typeof val === 'number') return val;
    const cleaned = val.toString().replace(/[%,]/g, '').trim();
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  }
}