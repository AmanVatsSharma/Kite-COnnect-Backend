/**
 * @file provider-label.util.ts
 * @module shared
 * @description Maps public provider aliases (Falcon/Vayu/Massive/Binance) to internal names and client-visible brand names.
 * @author BharatERP
 * @created 2026-03-28
 * @updated 2026-04-26
 */

export type InternalProviderName = 'kite' | 'vortex' | 'massive' | 'binance';
export type ClientVisibleProviderName = 'Falcon' | 'Vayu' | 'Massive' | 'Binance';

/**
 * Normalize HTTP/header/admin input: falcon→kite, vayu→vortex, polygon→massive, binance is canonical.
 */
export function normalizeProviderAlias(
  raw: string | null | undefined,
): InternalProviderName | null {
  if (raw == null || raw === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'kite' || v === 'falcon') return 'kite';
  if (v === 'vortex' || v === 'vayu') return 'vortex';
  if (v === 'massive' || v === 'polygon') return 'massive';
  if (v === 'binance') return 'binance';
  return null;
}

/** Brand shown to API/WebSocket clients (never expose internal names in customer payloads). */
export function internalToClientProviderName(
  internal: InternalProviderName,
): ClientVisibleProviderName {
  if (internal === 'vortex') return 'Vayu';
  if (internal === 'massive') return 'Massive';
  if (internal === 'binance') return 'Binance';
  return 'Falcon';
}
