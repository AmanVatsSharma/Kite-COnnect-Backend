/**
 * @file tick-shape.util.ts
 * @module market-data
 * @description Shapes full provider ticks for client-requested streaming mode (ltp / ohlcv / full).
 * @author BharatERP
 * @created 2025-03-23
 * @updated 2026-04-18
 */

export type StreamTickMode = 'ltp' | 'ohlcv' | 'full';

/** Optional flags on outbound `market_data` frames (e.g. synthetic last-tick pulse). */
export type MarketTickEmitOptions = { syntheticLast?: boolean };

/**
 * Returns a payload appropriate for the subscriber mode (bandwidth / contract sync).
 * Enriches output with UIR fields (`uir_id`, `symbol`) when present on the raw tick.
 */
export function shapeMarketTickForMode(raw: any, mode: StreamTickMode): any {
  if (!raw || typeof raw !== 'object') {
    return raw;
  }
  const instrument_token = raw.instrument_token;
  const exchange = raw.exchange;
  const last_price = raw.last_price;
  // UIR enrichment fields (set by handleTicks when registry is populated)
  const uir_id = raw._uirId;
  const symbol = raw._canonicalSymbol;
  if (mode === 'ltp') {
    return { instrument_token, exchange, last_price, uir_id, symbol };
  }
  if (mode === 'ohlcv') {
    return {
      instrument_token,
      exchange,
      last_price,
      last_trade_time: raw.last_trade_time,
      volume: raw.volume,
      ohlc: raw.ohlc,
      uir_id,
      symbol,
    };
  }
  const { _uirId, _canonicalSymbol, ...rest } = raw;
  return { ...rest, uir_id: _uirId, symbol: _canonicalSymbol };
}
