/**
 * @file apps/search-api/src/modules/search/provider-aliases.ts
 * @module search-api
 * @description Local copy of the provider alias mapping. The search-api runs as a
 *              separate Docker container with its own tsconfig — it cannot import
 *              from the main backend's `src/shared/utils/provider-label.util.ts`,
 *              so this file mirrors it. Keep in sync when adding providers.
 *
 * Brand mapping (public ↔ internal):
 *   - kite     ↔ falcon  (Indian equity catalog via Kite Connect)
 *   - vortex   ↔ vayu    (Indian F&O / currency / commodities via Rupeezy/Vortex)
 *   - massive  ↔ atlas   (US stocks / forex / options / indices via Polygon→Massive)
 *   - binance  ↔ drift   (global crypto Spot via Binance.com)
 *
 * Exports:
 *   - InternalProviderName        — internal canonical names (used inside Meili docs)
 *   - PublicProviderName          — lowercase public brand names (used in JSON outputs)
 *   - normalizeProviderAlias(raw) — accepts internal/public/legacy aliases → internal name
 *   - internalToPublicProvider(i) — internal → public lowercase brand
 *   - publicToInternalProvider(p) — public lowercase brand → internal (strict)
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-01
 */

export type InternalProviderName = 'kite' | 'vortex' | 'massive' | 'binance';
export type PublicProviderName = 'falcon' | 'vayu' | 'atlas' | 'drift';

/**
 * Normalize HTTP/admin/search input to an internal provider name.
 * Accepts both internal canonicals, public brand names, and legacy aliases (`polygon`).
 * Returns null for unrecognized input — callers should treat that as "no filter".
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

/** Internal → public lowercase brand. Used when shaping the search response. */
export function internalToPublicProvider(
  internal: InternalProviderName,
): PublicProviderName {
  if (internal === 'vortex') return 'vayu';
  if (internal === 'massive') return 'atlas';
  if (internal === 'binance') return 'drift';
  return 'falcon';
}

/** Public → internal (strict). Returns null for unknown public names. */
export function publicToInternalProvider(
  pub: string | null | undefined,
): InternalProviderName | null {
  if (pub == null) return null;
  const v = String(pub).trim().toLowerCase();
  if (v === 'falcon') return 'kite';
  if (v === 'vayu') return 'vortex';
  if (v === 'atlas') return 'massive';
  if (v === 'drift') return 'binance';
  return null;
}
