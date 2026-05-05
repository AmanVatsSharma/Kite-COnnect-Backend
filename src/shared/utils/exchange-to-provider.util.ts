/**
 * @file exchange-to-provider.util.ts
 * @module shared
 * @description Maps canonical exchange codes (universal_instruments.exchange) to their streaming provider.
 * @author BharatERP
 * @created 2026-04-19
 * @updated 2026-04-26
 */
import { InternalProviderName } from './provider-label.util';

/**
 * Canonical exchange → streaming provider routing table.
 *
 * NSE/BSE-listed instruments with instrument_type=IDX (e.g. NIFTY) have exchange=NSE and route
 * to Kite. Polygon.io indices have exchange=IDX (set by Massive sync) and route to Massive.
 * Binance crypto pairs (BTCUSDT, ETHUSDT, ...) live under exchange=BINANCE and stream from
 * Binance combined-stream WS — distinct from the generic CRYPTO exchange used by Massive.
 */
export const EXCHANGE_TO_PROVIDER: Readonly<
  Record<string, InternalProviderName>
> = {
  NSE: 'kite',
  BSE: 'kite',
  NFO: 'kite',
  BFO: 'kite',
  MCX: 'kite',
  CDS: 'kite',
  BCD: 'kite',
  US: 'massive',
  FX: 'massive',
  CRYPTO: 'massive',
  IDX: 'massive',
  BINANCE: 'binance',
} as const;

export function getProviderForExchange(
  exchange: string,
): InternalProviderName | undefined {
  return EXCHANGE_TO_PROVIDER[exchange];
}
