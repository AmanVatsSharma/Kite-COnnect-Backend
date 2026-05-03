/**
 * @file binance-ws-event.dto.ts
 * @module binance
 * @description TypeScript shapes for Binance combined-stream WS frames.
 * @author BharatERP
 * @created 2026-04-26
 * @updated 2026-04-26
 */

/**
 * Wrapper Binance puts around every payload in /stream?streams=...
 * { stream: "btcusdt@trade", data: <payload> }
 */
export interface BinanceCombinedFrame<T = unknown> {
  stream: string;
  data: T;
}

/**
 * `<symbol>@trade` payload — fires on every executed trade.
 * Field reference: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams#trade-streams
 */
export interface BinanceTradeEvent {
  e: 'trade';
  E: number; // event time
  s: string; // symbol, e.g. "BTCUSDT"
  t: number; // trade id
  p: string; // price (decimal string)
  q: string; // quantity (decimal string)
  T: number; // trade time (ms epoch)
  m: boolean; // is the buyer the market maker?
  M: boolean; // ignore (deprecated)
}

/** JSON-RPC ack for subscribe/unsubscribe — `{result:null,id:N}`. */
export interface BinanceJsonRpcAck {
  result: null;
  id: number;
}

/** JSON-RPC error envelope. */
export interface BinanceJsonRpcError {
  error: { code: number; msg: string };
  id: number;
}

/** Any frame the WS may emit. */
export type BinanceWsFrame =
  | BinanceCombinedFrame<BinanceTradeEvent>
  | BinanceJsonRpcAck
  | BinanceJsonRpcError;

/** Canonical tick shape emitted to the streaming layer (matches MassiveCanonicalTick). */
export interface BinanceCanonicalTick {
  instrument_token: string;
  last_price: number;
  exchange: string; // 'BINANCE'
  volume?: number;
  last_trade_time?: number;
}
