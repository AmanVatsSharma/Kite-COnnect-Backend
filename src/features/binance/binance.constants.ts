/**
 * @file binance.constants.ts
 * @module binance
 * @description Binance.com (global) Spot endpoints and protocol constants.
 * @author BharatERP
 * @created 2026-04-26
 * @updated 2026-04-26
 */

/** Binance Spot REST base URL (binance.com global, not binance.us). */
export const BINANCE_REST_BASE = 'https://api.binance.com';

/** Binance Spot combined-stream WebSocket base. Streams are added/removed via SUBSCRIBE / UNSUBSCRIBE JSON-RPC frames. */
export const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/stream';

/** Hard limit per single Binance combined-stream connection. */
export const BINANCE_MAX_STREAMS_PER_CONNECTION = 1024;

/**
 * Default quote currencies retained when ingesting `/api/v3/exchangeInfo`.
 * Override via env `BINANCE_QUOTES` (comma-separated).
 * Yields ~800 liquid pairs out of Binance's ~2000 total.
 */
export const BINANCE_DEFAULT_QUOTE_FILTER = ['USDT', 'USDC', 'BUSD', 'BTC', 'ETH'] as const;

/** Canonical exchange code used in `universal_instruments.exchange` for Binance pairs. */
export const BINANCE_CANONICAL_EXCHANGE = 'BINANCE';

/** Provider name registered with `MarketDataProvider`. */
export const BINANCE_PROVIDER_NAME = 'binance' as const;

/** WS event types this client understands. */
export const BINANCE_WS_EVENTS = {
  TRADE: 'trade',
} as const;

/**
 * Stream channel suffixes per mode. v1 ships @trade-only — kline/bookTicker reserved for v2.
 * The streaming layer's mode tags ('ltp'|'ohlcv'|'full') all map to @trade.
 */
export const BINANCE_STREAM_SUFFIX = {
  TRADE: '@trade',
} as const;
