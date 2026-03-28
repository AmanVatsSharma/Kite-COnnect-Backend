/**
 * @file tick-shape.util.ts
 * @module market-data
 * @description Shapes full provider ticks for client-requested streaming mode (ltp / ohlcv / full).
 * @author BharatERP
 * @created 2025-03-23
 * @updated 2026-03-24
 */

export type StreamTickMode = 'ltp' | 'ohlcv' | 'full';

/** Optional flags on outbound `market_data` frames (e.g. synthetic last-tick pulse). */
export type MarketTickEmitOptions = { syntheticLast?: boolean };

/**
 * Returns a payload appropriate for the subscriber mode (bandwidth / contract sync).
 */
export function shapeMarketTickForMode(raw: any, mode: StreamTickMode): any {
  if (!raw || typeof raw !== 'object') {
    return raw;
  }
  const instrument_token = raw.instrument_token;
  const exchange = raw.exchange;
  const last_price = raw.last_price;
  if (mode === 'ltp') {
    return { instrument_token, exchange, last_price };
  }
  if (mode === 'ohlcv') {
    return {
      instrument_token,
      exchange,
      last_price,
      last_trade_time: raw.last_trade_time,
      volume: raw.volume,
      ohlc: raw.ohlc,
    };
  }
  return { ...raw };
}
