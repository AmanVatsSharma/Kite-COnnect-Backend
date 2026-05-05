/**
 * @file massive.constants.ts
 * @module massive
 * @description Shared constants for the Massive (formerly Polygon.io) provider.
 * @author BharatERP
 * @created 2026-04-18
 * @updated 2026-04-18
 */

export const MASSIVE_REST_BASE = 'https://api.massive.com';
export const MASSIVE_WS_REALTIME_BASE = 'wss://socket.massive.com';
export const MASSIVE_WS_DELAYED_BASE = 'wss://delayed.socket.massive.com';
export const MASSIVE_FILES_BASE = 'https://files.massive.com';

/** Supported WebSocket asset classes. */
export type MassiveAssetClass =
  | 'stocks'
  | 'forex'
  | 'crypto'
  | 'options'
  | 'indices';

/** WebSocket event types emitted by Massive. */
export const MASSIVE_WS_EVENTS = {
  TRADE: 'T',
  QUOTE: 'Q',
  MINUTE_AGG: 'AM',
  SECOND_AGG: 'A',
  CRYPTO_TRADE: 'XT',
  CRYPTO_QUOTE: 'XQ',
  CRYPTO_AGG: 'XA',
  FOREX_QUOTE: 'C',
  FOREX_AGG: 'CA',
  STATUS: 'status',
} as const;

/** Intervals supported by the aggregates REST endpoint. */
export const MASSIVE_INTERVALS: Record<
  string,
  { multiplier: number; timespan: string }
> = {
  minute: { multiplier: 1, timespan: 'minute' },
  '5minute': { multiplier: 5, timespan: 'minute' },
  '15minute': { multiplier: 15, timespan: 'minute' },
  '30minute': { multiplier: 30, timespan: 'minute' },
  '60minute': { multiplier: 60, timespan: 'minute' },
  hour: { multiplier: 1, timespan: 'hour' },
  day: { multiplier: 1, timespan: 'day' },
  week: { multiplier: 1, timespan: 'week' },
  month: { multiplier: 1, timespan: 'month' },
};
