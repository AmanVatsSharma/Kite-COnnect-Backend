/**
 * @file exchange-normalizer.ts
 * @module shared
 * @description Normalizes provider-specific exchange codes to canonical form and back.
 * @author BharatERP
 * @created 2026-04-17
 * @updated 2026-04-17
 */

/**
 * Maps Kite exchange codes to canonical exchange codes.
 * Kite codes are mostly identity mappings but listed explicitly for completeness.
 */
export const KITE_TO_CANONICAL: Record<string, string> = {
  NSE: 'NSE',
  BSE: 'BSE',
  NFO: 'NFO',
  CDS: 'CDS',
  MCX: 'MCX',
  BCD: 'BCD',
  BFO: 'BFO',
};

/**
 * Maps Vortex exchange codes to canonical exchange codes.
 */
export const VORTEX_TO_CANONICAL: Record<string, string> = {
  NSE_EQ: 'NSE',
  NSE_FO: 'NFO',
  NSE_CUR: 'CDS',
  MCX_FO: 'MCX',
};

/** Reverse map: canonical -> Kite exchange code */
const CANONICAL_TO_KITE: Record<string, string> = Object.fromEntries(
  Object.entries(KITE_TO_CANONICAL).map(([k, v]) => [v, k]),
);

/** Reverse map: canonical -> Vortex exchange code */
const CANONICAL_TO_VORTEX: Record<string, string> = Object.fromEntries(
  Object.entries(VORTEX_TO_CANONICAL).map(([k, v]) => [v, k]),
);

/**
 * Converts a provider-specific exchange code to canonical form.
 * Returns the input unchanged if no mapping is found.
 */
export function normalizeExchange(
  providerExchange: string,
  provider: 'kite' | 'vortex',
): string {
  const map = provider === 'kite' ? KITE_TO_CANONICAL : VORTEX_TO_CANONICAL;
  return map[providerExchange] ?? providerExchange;
}

/**
 * Converts a canonical exchange code back to a provider-specific code.
 * Returns the input unchanged if no mapping is found.
 */
export function denormalizeExchange(
  canonical: string,
  provider: 'kite' | 'vortex',
): string {
  const map = provider === 'kite' ? CANONICAL_TO_KITE : CANONICAL_TO_VORTEX;
  return map[canonical] ?? canonical;
}
