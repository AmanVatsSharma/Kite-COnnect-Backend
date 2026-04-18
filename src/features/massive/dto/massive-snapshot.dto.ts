/**
 * @file massive-snapshot.dto.ts
 * @module massive
 * @description REST snapshot response shapes for Massive API.
 * @author BharatERP
 * @created 2026-04-18
 * @updated 2026-04-18
 */

export interface MassiveLastTrade {
  p: number;    // price
  s: number;    // size
  t: number;    // timestamp (Unix ms)
  x?: number;  // exchange
}

export interface MassiveLastQuote {
  P?: number;  // ask price
  S?: number;  // ask size
  p?: number;  // bid price
  s?: number;  // bid size
  t?: number;  // timestamp
}

export interface MassiveDayBar {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
}

export interface MassiveMinBar {
  av?: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
  t: number;
}

export interface MassiveTicker {
  ticker: string;
  todaysChangePerc?: number;
  todaysChange?: number;
  updated?: number;
  day?: MassiveDayBar;
  lastTrade?: MassiveLastTrade;
  lastQuote?: MassiveLastQuote;
  min?: MassiveMinBar;
  prevDay?: MassiveDayBar;
}

export interface MassiveSnapshotResponse {
  ticker?: MassiveTicker;
  tickers?: MassiveTicker[];
  status: string;
  request_id?: string;
  count?: number;
}

export interface MassiveReferenceTickersResponse {
  results: Array<{
    ticker: string;
    name: string;
    market: string;
    locale: string;
    type?: string;
    active?: boolean;
    currency_name?: string;
  }>;
  status: string;
  request_id: string;
  count: number;
  next_url?: string;
}
