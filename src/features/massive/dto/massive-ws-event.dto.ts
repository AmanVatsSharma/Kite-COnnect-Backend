/**
 * @file massive-ws-event.dto.ts
 * @module massive
 * @description WebSocket event shapes for Massive real-time data feed.
 * @author BharatERP
 * @created 2026-04-18
 * @updated 2026-04-18
 */

export interface MassiveStatusEvent {
  ev: 'status';
  status: 'connected' | 'auth_success' | 'auth_failed' | 'success' | 'error';
  message: string;
}

export interface MassiveTradeEvent {
  ev: 'T';
  sym: string;
  i?: string;        // trade ID
  x: number;        // exchange ID
  p: number;        // price
  s: number;        // size
  c?: number[];     // conditions
  t: number;        // timestamp (Unix ms)
  q?: number;       // sequence number
}

export interface MassiveQuoteEvent {
  ev: 'Q';
  sym: string;
  bx?: number;      // bid exchange
  bp: number;       // bid price
  bs: number;       // bid size
  ax?: number;      // ask exchange
  ap: number;       // ask price
  as: number;       // ask size
  c?: number[];     // conditions
  t: number;        // timestamp (Unix ms)
}

export interface MassiveMinuteAggEvent {
  ev: 'AM' | 'A';
  sym: string;
  v: number;        // volume
  av?: number;      // accumulated volume (today)
  op?: number;      // official opening price
  vw: number;       // VWAP
  o: number;        // open
  c: number;        // close (last in window)
  h: number;        // high
  l: number;        // low
  a?: number;       // average price
  z?: number;       // avg trade size
  s: number;        // window start (Unix ms)
  e: number;        // window end (Unix ms)
  t?: number;       // alias for s on some feeds
}

export interface MassiveCryptoTradeEvent {
  ev: 'XT';
  pair: string;
  p: number;
  s: number;
  t: number;
  x: number;
}

export interface MassiveCryptoAggEvent {
  ev: 'XA';
  pair: string;
  o: number;
  c: number;
  h: number;
  l: number;
  v: number;
  s: number;
  e: number;
}

export interface MassiveCryptoQuoteEvent {
  ev: 'XQ';
  pair: string;
  bp: number;
  bs: number;
  ap: number;
  as: number;
  t: number;
}

export interface MassiveForexQuoteEvent {
  ev: 'C';
  p: string;        // pair e.g. "EUR/USD"
  a: number;        // ask
  b: number;        // bid
  t: number;
  x: number;
}

export interface MassiveForexAggEvent {
  ev: 'CA';
  p: string;
  o: number;
  c: number;
  h: number;
  l: number;
  v: number;
  s: number;
  e: number;
}

export type MassiveWsEvent =
  | MassiveStatusEvent
  | MassiveTradeEvent
  | MassiveQuoteEvent
  | MassiveMinuteAggEvent
  | MassiveCryptoTradeEvent
  | MassiveCryptoAggEvent
  | MassiveCryptoQuoteEvent
  | MassiveForexQuoteEvent
  | MassiveForexAggEvent;
