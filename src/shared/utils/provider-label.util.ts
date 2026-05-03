/**
 * @file provider-label.util.ts
 * @module shared
 * @description Maps public provider aliases (Falcon/Vayu/Atlas/Drift) to internal names and client-visible brand names.
 * @author BharatERP
 * @created 2026-03-28
 * @updated 2026-05-01
 *
 * Brand mapping (public ↔ internal):
 *   - kite     ↔ Falcon (Indian equity catalog via Kite Connect)
 *   - vortex   ↔ Vayu   (Indian F&O / currency / commodities via Rupeezy/Vortex)
 *   - massive  ↔ Atlas  (US stocks / forex / options / indices via Polygon→Massive)
 *   - binance  ↔ Drift  (global crypto Spot via Binance.com)
 *
 * Backwards-compat aliases accepted on input only: `polygon` (=massive), `massive`/`binance`
 * still resolve to themselves so older API consumers don't break — but new outbound payloads
 * always use the public brand names (Falcon/Vayu/Atlas/Drift).
 */

export type InternalProviderName = 'kite' | 'vortex' | 'massive' | 'binance';
export type ClientVisibleProviderName = 'Falcon' | 'Vayu' | 'Atlas' | 'Drift';
/** Lowercase form of the client-visible brand — used in JSON field values like streamProvider. */
export type PublicProviderName = 'falcon' | 'vayu' | 'atlas' | 'drift';

/**
 * Normalize HTTP/header/admin/search input to an internal provider name.
 * Accepts both internal canonicals (`kite`/`vortex`/`massive`/`binance`),
 * public brand names (`falcon`/`vayu`/`atlas`/`drift`), and legacy aliases (`polygon`).
 */
export function normalizeProviderAlias(
  raw: string | null | undefined,
): InternalProviderName | null {
  if (raw == null || raw === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'kite' || v === 'falcon') return 'kite';
  if (v === 'vortex' || v === 'vayu') return 'vortex';
  if (v === 'massive' || v === 'polygon' || v === 'atlas') return 'massive';
  if (v === 'binance' || v === 'drift') return 'binance';
  return null;
}

/** Brand shown to API/WebSocket clients (never expose internal names in customer payloads). */
export function internalToClientProviderName(
  internal: InternalProviderName,
): ClientVisibleProviderName {
  if (internal === 'vortex') return 'Vayu';
  if (internal === 'massive') return 'Atlas';
  if (internal === 'binance') return 'Drift';
  return 'Falcon';
}

/** Lowercase brand for JSON field values (e.g. streamProvider in the search response). */
export function internalToPublicProviderName(
  internal: InternalProviderName,
): PublicProviderName {
  if (internal === 'vortex') return 'vayu';
  if (internal === 'massive') return 'atlas';
  if (internal === 'binance') return 'drift';
  return 'falcon';
}
