/**
 * @file massive-aggs.dto.ts
 * @module massive
 * @description REST aggregate (OHLCV) response shapes for Massive API.
 * @author BharatERP
 * @created 2026-04-18
 * @updated 2026-04-18
 */

export interface MassiveAggResult {
  v: number; // volume
  vw: number; // VWAP
  o: number; // open
  c: number; // close
  h: number; // high
  l: number; // low
  t: number; // start of window (Unix ms)
  n?: number; // number of transactions
}

export interface MassiveAggsResponse {
  ticker: string;
  queryCount: number;
  resultsCount: number;
  adjusted: boolean;
  results: MassiveAggResult[];
  status: string;
  request_id: string;
  count: number;
  next_url?: string;
}
