/**
 * @file fundamentals-response.dto.ts
 * @module fundamentals/dto
 * @description Response DTOs for the fundamentals controller.
 * @author BharatERP
 * @created 2026-05-24
 * @updated 2026-05-24
 */
export class FundamentalsResponseDto {
  success: boolean;
  dataStale?: boolean;
  source: 'cache' | 'fresh' | 'stale';
  data: FundamentalsDataDto | { error: string };
  fetchedAt?: string;
}

export class FundamentalsDataDto {
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

export class CacheStatsDto {
  total: number;
  fresh: number;
  stale: number;
  byExchange: Record<string, number>;
}