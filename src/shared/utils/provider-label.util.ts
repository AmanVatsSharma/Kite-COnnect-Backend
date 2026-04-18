/**
 * @file provider-label.util.ts
 * @module shared
 * @description Maps public provider aliases (Falcon/Vayu/Massive) to internal names and client-visible brand names.
 * @author BharatERP
 * @created 2026-03-28
 * @updated 2026-04-18
 */

export type InternalProviderName = 'kite' | 'vortex' | 'massive';
export type ClientVisibleProviderName = 'Falcon' | 'Vayu' | 'Massive';

/**
 * Normalize HTTP/header/admin input: falcon→kite, vayu→vortex, polygon→massive, plus canonical names.
 */
export function normalizeProviderAlias(
  raw: string | null | undefined,
): InternalProviderName | null {
  if (raw == null || raw === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'kite' || v === 'falcon') return 'kite';
  if (v === 'vortex' || v === 'vayu') return 'vortex';
  if (v === 'massive' || v === 'polygon') return 'massive';
  return null;
}

/** Brand shown to API/WebSocket clients (never expose internal names in customer payloads). */
export function internalToClientProviderName(
  internal: InternalProviderName,
): ClientVisibleProviderName {
  if (internal === 'vortex') return 'Vayu';
  if (internal === 'massive') return 'Massive';
  return 'Falcon';
}
