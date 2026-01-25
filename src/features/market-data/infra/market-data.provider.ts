import { Logger } from '@nestjs/common';

// MarketDataProvider defines the contract implemented by concrete providers (Kite, Vortex).
// Implementations must be resilient: never crash the app; always log failures clearly; return
// empty data or safe no-ops when unconfigured.
export interface MarketDataProvider {
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
  // Streaming
  initializeTicker(): any;
  getTicker(): any;
}

// A minimal ticker-like interface (duck-typed) used by the streaming layer. Providers should
// return an object matching this shape. We do not export a type to avoid tight coupling with
// concrete SDKs.
export type TickerLike = any;

export const ProviderLogger = new Logger('MarketDataProvider');
