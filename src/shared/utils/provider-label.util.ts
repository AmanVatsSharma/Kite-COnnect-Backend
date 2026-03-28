/**
 * @file provider-label.util.ts
 * @module shared
 * @description Maps public provider aliases (Falcon/Vayu) to internal kite/vortex and client-visible brand names.
 * @author BharatERP
 * @created 2026-03-28
 */

export type InternalProviderName = 'kite' | 'vortex';
export type ClientVisibleProviderName = 'Falcon' | 'Vayu';

/**
 * Normalize HTTP/header/admin input: falcon→kite, vayu→vortex, plus canonical names.
 */
export function normalizeProviderAlias(
  raw: string | null | undefined,
): InternalProviderName | null {
  if (raw == null || raw === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'kite' || v === 'falcon') return 'kite';
  if (v === 'vortex' || v === 'vayu') return 'vortex';
  return null;
}

/** Brand shown to API/WebSocket clients (never expose kite/vortex in customer payloads). */
export function internalToClientProviderName(
  internal: InternalProviderName,
): ClientVisibleProviderName {
  return internal === 'vortex' ? 'Vayu' : 'Falcon';
}
