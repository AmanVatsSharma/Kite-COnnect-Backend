/**
 * @file binance-exchange-info.dto.ts
 * @module binance
 * @description TypeScript shapes for /api/v3/exchangeInfo (Binance Spot symbol catalog).
 * @author BharatERP
 * @created 2026-04-26
 * @updated 2026-04-26
 */

/** One filter inside symbol.filters[]. We only consume PRICE_FILTER, LOT_SIZE, MIN_NOTIONAL/NOTIONAL. */
export interface BinancePriceFilter {
  filterType: 'PRICE_FILTER';
  minPrice: string;
  maxPrice: string;
  tickSize: string;
}

export interface BinanceLotSizeFilter {
  filterType: 'LOT_SIZE';
  minQty: string;
  maxQty: string;
  stepSize: string;
}

/** Older payload uses MIN_NOTIONAL; current spec also exposes NOTIONAL. */
export interface BinanceMinNotionalFilter {
  filterType: 'MIN_NOTIONAL' | 'NOTIONAL';
  minNotional?: string;
  applyToMarket?: boolean;
  avgPriceMins?: number;
}

export type BinanceSymbolFilter =
  | BinancePriceFilter
  | BinanceLotSizeFilter
  | BinanceMinNotionalFilter
  | { filterType: string; [k: string]: unknown };

/** One row in exchangeInfo.symbols[]. */
export interface BinanceExchangeInfoSymbol {
  symbol: string;
  status: string; // TRADING | HALT | BREAK | ...
  baseAsset: string;
  baseAssetPrecision: number;
  quoteAsset: string;
  quotePrecision: number;
  quoteAssetPrecision: number;
  orderTypes: string[];
  isSpotTradingAllowed: boolean;
  isMarginTradingAllowed?: boolean;
  permissions?: string[];
  filters: BinanceSymbolFilter[];
}

/** Response of GET /api/v3/exchangeInfo. */
export interface BinanceExchangeInfoResponse {
  timezone: string;
  serverTime: number;
  rateLimits: Array<Record<string, unknown>>;
  exchangeFilters: unknown[];
  symbols: BinanceExchangeInfoSymbol[];
}

/** Response of GET /api/v3/ticker/price. */
export interface BinanceTickerPrice {
  symbol: string;
  price: string;
}

/** Response of GET /api/v3/ticker/24hr (single symbol or array). */
export interface BinanceTicker24hr {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  prevClosePrice: string;
  lastPrice: string;
  lastQty: string;
  bidPrice: string;
  askPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  openTime: number;
  closeTime: number;
  firstId: number;
  lastId: number;
  count: number;
}

/** One row from GET /api/v3/klines (array of arrays). */
export type BinanceKline = [
  number, // openTime
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // closeTime
  string, // quoteAssetVolume
  number, // numberOfTrades
  string, // takerBuyBaseAssetVolume
  string, // takerBuyQuoteAssetVolume
  string, // ignore
];
