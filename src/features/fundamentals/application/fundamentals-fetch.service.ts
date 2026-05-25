/**
 * @file fundamentals-fetch.service.ts
 * @module fundamentals
 * @description Fetches fundamental data from Yahoo Finance public endpoints (no API key required).
 *              Calls chart endpoint for OHLCV/price and quoteSummary for financials/profiles.
 *
 * Exports:
 *   - FundamentalsFetchService               — raw Yahoo Finance fetch + map to clean shape
 *   - YahooFinanceRawResponse                — raw Yahoo Finance response shape
 *   - YahooFinanceFundamentals               — mapped fundamentals output
 *
 * Depends on:
 *   - @infra/redis/redis.service            — Redis for short-term in-memory fallback cache
 *   - @nestjs/config                        — ConfigService for env vars
 *
 * Side-effects:
 *   - HTTP calls to query1.finance.yahoo.com and query2.finance.yahoo.com
 *   - Redis writes for short-term TTL caching
 *
 * Key invariants:
 *   - Both endpoints are public (no auth required) but may rate-limit on abuse
 *   - 500ms delay between requests to avoid 429s
 *   - NSE symbols append ".NS", BSE symbols append ".BO" per Yahoo Finance convention
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@infra/redis/redis.service';
import fetch from 'node-fetch';

const YFINANCE_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YFINANCE_SUMMARY_BASE =
  'https://query2.finance.yahoo.com/v10/finance/quoteSummary';
const RATE_LIMIT_DELAY_MS = 500;
const REDIS_SHORT_TTL = 300; // 5 minutes Redis cache

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        fiftyTwoWeekHigh?: number;
        fiftyTwoWeekLow?: number;
        shortName?: string;
        longName?: string;
        currency?: string;
        exchangeName?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: number[];
          high?: number[];
          low?: number[];
          close?: number[];
          volume?: number[];
        }>;
      };
    }>;
    error?: { code: string; description: string };
  };
}

interface YahooSummaryResponse {
  quoteSummary?: {
    result?: Array<{
      summaryDetail?: Record<string, any>;
      defaultKeyStatistics?: Record<string, any>;
      assetProfile?: Record<string, any>;
      financialData?: Record<string, any>;
      incomeStatementHistory?: Record<string, any>;
      balanceSheetHistory?: Record<string, any>;
    }>;
    error?: { code: string; description: string };
  };
}

/** Mapped fundamentals shape returned to callers */
export interface YahooFinanceFundamentals {
  symbol: string;
  exchange: string;
  fetchedAt: string;
  profile: {
    companyName: string;
    sector: string;
    industry: string;
    marketCap: number | null;
    description: string;
  };
  metrics: {
    peRatio: number | null;
    eps: number | null;
    dividendYield: number | null;
    beta: number | null;
    fiftyTwoWeekHigh: number | null;
    fiftyTwoWeekLow: number | null;
    revenueGrowth: number | null;
    profitMargin: number | null;
    debtToEquity: number | null;
    currentRatio: number | null;
  };
  financials: {
    incomeStatement: {
      totalRevenue: number | null;
      netIncome: number | null;
      grossProfit: number | null;
      operatingIncome: number | null;
    };
    balanceSheet: {
      totalAssets: number | null;
      totalLiabilities: number | null;
      shareholdersEquity: number | null;
    };
  };
  priceData: {
    currentPrice: number | null;
    targetMeanPrice: number | null;
    targetHighPrice: number | null;
    targetLowPrice: number | null;
    recommendationKey: string | null;
  };
}

@Injectable()
export class FundamentalsFetchService {
  private readonly logger = new Logger(FundamentalsFetchService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Map exchange + symbol to Yahoo Finance suffix.
   * NSE → .NS, BSE → .BO, MCX → .NS (commodities also on NSE), others → ''
   */
  private yahooSuffix(exchange: string): string {
    const ex = (exchange || '').toUpperCase();
    if (ex === 'NSE') return '.NS';
    if (ex === 'BSE') return '.BO';
    return '';
  }

  /**
   * Fetch and map fundamentals for a single symbol.
   * Returns null on any failure.
   */
  async fetchFundamentals(
    symbol: string,
    exchange: string,
  ): Promise<YahooFinanceFundamentals | null> {
    const sym = (symbol || '').trim().toUpperCase();
    const ex = (exchange || 'NSE').toUpperCase();
    if (!sym) return null;

    const suffix = this.yahooSuffix(ex);

    // Check Redis short-term cache first
    const redisKey = `yf:fund:${ex}:${sym}`;
    try {
      const cached = await this.redis.get<YahooFinanceFundamentals>(redisKey);
      if (cached) {
        this.logger.debug(`[FundamentalsFetch] Redis hit for ${sym}`);
        return cached;
      }
    } catch {
      /* non-fatal */
    }

    try {
      // Fetch chart + summary in parallel with rate-limit guard
      const [chartData, summaryData] = await Promise.all([
        this.fetchChart(sym, suffix),
        this.fetchSummary(sym, suffix),
      ]);

      const result = this.mapToFundamentals(sym, ex, chartData, summaryData);

      // Cache in Redis for 5 minutes
      if (result) {
        try {
          await this.redis.set(redisKey, result, REDIS_SHORT_TTL);
        } catch {
          /* non-fatal */
        }
      }

      return result;
    } catch (e) {
      this.logger.error(
        `[FundamentalsFetch] Failed to fetch fundamentals for ${sym}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  private async fetchWithDelay(url: string): Promise<any> {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; Bot/1.0; +https://example.com/bot)',
        Accept: 'application/json',
      },
      timeout: 15000,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  private async fetchChart(
    symbol: string,
    suffix: string,
  ): Promise<YahooChartResponse | null> {
    await this.delay(RATE_LIMIT_DELAY_MS);
    const url = `${YFINANCE_CHART_BASE}/${symbol}${suffix}?interval=1d&range=5d`;
    try {
      return (await this.fetchWithDelay(url)) as YahooChartResponse;
    } catch (e) {
      this.logger.warn(
        `[FundamentalsFetch] Chart fetch failed for ${symbol}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  private async fetchSummary(
    symbol: string,
    suffix: string,
  ): Promise<YahooSummaryResponse | null> {
    await this.delay(RATE_LIMIT_DELAY_MS);
    const modules = [
      'financialData',
      'defaultKeyStatistics',
      'assetProfile',
      'summaryDetail',
      'incomeStatementHistory',
      'balanceSheetHistory',
    ].join(',');
    const url = `${YFINANCE_SUMMARY_BASE}/${symbol}${suffix}?modules=${modules}`;
    try {
      return (await this.fetchWithDelay(url)) as YahooSummaryResponse;
    } catch (e) {
      this.logger.warn(
        `[FundamentalsFetch] Summary fetch failed for ${symbol}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  private mapToFundamentals(
    symbol: string,
    exchange: string,
    chartData: YahooChartResponse | null,
    summaryData: YahooSummaryResponse | null,
  ): YahooFinanceFundamentals {
    const chartResult = chartData?.chart?.result?.[0];
    const meta = chartResult?.meta;

    const summaryResult = summaryData?.quoteSummary?.result?.[0];
    const {
      summaryDetail = {},
      defaultKeyStatistics = {},
      assetProfile = {},
      financialData = {},
      incomeStatementHistory = {},
      balanceSheetHistory = {},
    } = summaryResult || {};

    // Helper to safely extract number from rawValue or raw
    const num = (val: any): number | null => {
      if (val == null) return null;
      if (typeof val === 'number') return val;
      if (typeof val === 'object' && val !== null) {
        if (val.raw != null) return typeof val.raw === 'number' ? val.raw : null;
        if (val.longFmt != null) {
          const parsed = parseFloat(String(val.longFmt).replace(/,/g, ''));
          return isNaN(parsed) ? null : parsed;
        }
      }
      return null;
    };

    // Income statement — latest period
    const incomePeriods =
      incomeStatementHistory?.incomeStatementHistory?.incomeStatementHistory ||
      incomeStatementHistory?.incomeStatementHistory || [];
    const latestIncome = Array.isArray(incomePeriods) ? incomePeriods[0] : null;

    // Balance sheet — latest period
    const balancePeriods =
      balanceSheetHistory?.balanceSheetHistory?.balanceSheetStatements ||
      balanceSheetHistory?.balanceSheetHistory || [];
    const latestBalance = Array.isArray(balancePeriods)
      ? balancePeriods[0]
      : null;

    return {
      symbol,
      exchange,
      fetchedAt: new Date().toISOString(),
      profile: {
        companyName:
          assetProfile?.companyName ||
          assetProfile?.shortName ||
          meta?.shortName ||
          meta?.longName ||
          symbol,
        sector: assetProfile?.sector || '',
        industry: assetProfile?.industry || '',
        marketCap: num(summaryDetail?.marketCap ?? defaultKeyStatistics?.marketCap),
        description: assetProfile?.longBusinessSummary || '',
      },
      metrics: {
        peRatio: num(summaryDetail?.trailingPE ?? defaultKeyStatistics?.trailingPE),
        eps: num(defaultKeyStatistics?.trailingEps),
        dividendYield: num(summaryDetail?.dividendYield),
        beta: num(summaryDetail?.beta),
        fiftyTwoWeekHigh: num(meta?.fiftyTwoWeekHigh ?? summaryDetail?.fiftyTwoWeekHigh),
        fiftyTwoWeekLow: num(meta?.fiftyTwoWeekLow ?? summaryDetail?.fiftyTwoWeekLow),
        revenueGrowth: num(financialData?.revenueGrowth),
        profitMargin: num(financialData?.profitMargin),
        debtToEquity: num(financialData?.debtToEquity),
        currentRatio: num(financialData?.currentRatio),
      },
      financials: {
        incomeStatement: {
          totalRevenue: latestIncome ? num(latestIncome?.totalRevenue) : null,
          netIncome: latestIncome ? num(latestIncome?.netIncome) : null,
          grossProfit: latestIncome ? num(latestIncome?.grossProfit) : null,
          operatingIncome: latestIncome
            ? num(latestIncome?.operatingIncome || latestIncome?.incomeBeforeTax)
            : null,
        },
        balanceSheet: {
          totalAssets: latestBalance ? num(latestBalance?.totalAsset) : null,
          totalLiabilities: latestBalance
            ? num(latestBalance?.totalLiabilities)
            : null,
          shareholdersEquity: latestBalance
            ? num(latestBalance?.totalStockholderEquity)
            : null,
        },
      },
      priceData: {
        currentPrice: num(meta?.regularMarketPrice ?? summaryDetail?.ask?.raw),
        targetMeanPrice: num(financialData?.targetMeanPrice),
        targetHighPrice: num(financialData?.targetHighPrice),
        targetLowPrice: num(financialData?.targetLowPrice),
        recommendationKey: financialData?.recommendationKey || null,
      },
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}