/**
 * @file market-data.provider.ts
 * @module market-data
 * @description Contract for Kite/Vortex market data providers (HTTP + streaming).
 * @author BharatERP
 * @created 2025-01-01
 */
import { Logger } from '@nestjs/common';

/** Pair key shape used by batch LTP (`EXCHANGE-TOKEN`). */
export type MarketDataLtpPair = {
  exchange: string;
  token: string | number;
};

/** Explicit exchange per token for WS subscribe / mapping prime. */
export type MarketDataExchangeToken = {
  token: number;
  exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO';
};

// MarketDataProvider defines the contract implemented by concrete providers (Kite, Vortex).
// Implementations must be resilient: never crash the app; always log failures clearly; return
// empty data or safe no-ops when unconfigured.
export interface MarketDataProvider {
  /** Provider identifier used for limit enforcement and metrics. */
  readonly providerName?: string;
  initialize(): Promise<void>;
  getInstruments(exchange?: string, opts?: any): Promise<any[]>;
  getQuote(tokens: string[]): Promise<Record<string, any>>;
  getLTP(tokens: string[]): Promise<Record<string, any>>;
  getOHLC(tokens: string[]): Promise<Record<string, any>>;
  getHistoricalData(
    token: number,
    from: string,
    to: string,
    interval: string,
  ): Promise<any>;
  /** Optional: pair-keyed LTP for Vortex-style batching; Kite maps via token-only LTP. */
  getLTPByPairs?(
    pairs: MarketDataLtpPair[],
  ): Promise<Record<string, { last_price: number | null }>>;
  /** Optional: prime upstream exchange map before WS subscribe (Vortex). */
  primeExchangeMapping?(pairs: MarketDataExchangeToken[]): void;
  // Streaming
  initializeTicker(): any;
  getTicker(): any;
}

// A minimal ticker-like interface (duck-typed) used by the streaming layer. Providers should
// return an object matching this shape. We do not export a type to avoid tight coupling with
// concrete SDKs.
export type TickerLike = any;

export const ProviderLogger = new Logger('MarketDataProvider');
