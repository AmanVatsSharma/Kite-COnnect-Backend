/**
 * @file kite-ticker.facade.ts
 * @module kite-connect
 * @description Wraps Kite Connect KiteTicker so streaming calls subscribe(tokens, mode) and setMode align with Kite wire modes (client ohlcv maps to quote).
 * @author BharatERP
 * @created 2026-03-28
 *
 * Notes:
 * - Kite SDK subscribe(tokens) ignores a second arg; mode must be sent via setMode(ltp|quote|full, tokens).
 */

export type KiteStreamModeArg = 'ltp' | 'ohlcv' | 'full' | string;

/** Kite upstream mode strings (see kiteconnect/lib/ticker.js). */
export type KiteUpstreamMode = 'ltp' | 'quote' | 'full';

/**
 * Map unified stream mode (Vortex-aligned API) to Kite WebSocket mode.
 */
export function mapStreamModeToKiteMode(
  mode: KiteStreamModeArg | undefined,
  ticker: {
    modeLTP?: string;
    modeQuote?: string;
    modeFull?: string;
  },
): KiteUpstreamMode {
  const m = String(mode ?? 'ltp').toLowerCase();
  if (m === 'ohlcv') {
    return (ticker.modeQuote ?? 'quote') as KiteUpstreamMode;
  }
  if (m === 'full') {
    return (ticker.modeFull ?? 'full') as KiteUpstreamMode;
  }
  return (ticker.modeLTP ?? 'ltp') as KiteUpstreamMode;
}

/**
 * Facade exposing subscribe(tokens, mode?) and setMode(mode, tokens) for MarketDataStreamService.
 * All other uses delegate to the raw SDK ticker.
 */
export function wrapKiteTickerForStreaming(inner: any): any {
  const map = (mode?: KiteStreamModeArg) =>
    mapStreamModeToKiteMode(mode, inner);
  return {
    subscribe(tokens: number[], mode?: KiteStreamModeArg) {
      inner.subscribe(tokens);
      if (mode != null && Array.isArray(tokens) && tokens.length > 0) {
        inner.setMode(map(mode), tokens);
      }
      return tokens;
    },
    setMode(mode: KiteStreamModeArg, tokens: number[]) {
      return inner.setMode(map(mode), tokens);
    },
    unsubscribe(tokens: number[]) {
      return inner.unsubscribe(tokens);
    },
    connect(...args: any[]) {
      return inner.connect?.(...args);
    },
    disconnect(...args: any[]) {
      return inner.disconnect?.(...args);
    },
    on(event: string, cb: (...args: any[]) => void) {
      return inner.on(event, cb);
    },
  };
}
