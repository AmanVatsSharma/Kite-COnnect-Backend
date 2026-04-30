/**
 * @file ws-provider-prefix.util.ts
 * @module shared
 * @description Parses WebSocket subscription identifiers with provider prefix syntax
 *              (Falcon:reliance, Vayu:26000, Atlas:AAPL, Drift:BTCUSDT, …).
 * @author BharatERP
 * @created 2026-04-28
 * @updated 2026-05-01
 */

import {
  InternalProviderName,
  normalizeProviderAlias,
} from '@shared/utils/provider-label.util';

/**
 * A subscription identifier that explicitly pins routing to one provider.
 * Produced by `parseProviderPrefix` when input matches `<alias>:<rest>` shape.
 */
export type ProviderPrefixed = {
  /** Canonical internal provider name (kite|vortex|massive|binance). */
  provider: InternalProviderName;
  /** Identifier portion after the first colon, trimmed. May itself contain colons (e.g. "NSE:RELIANCE"). */
  identifier: string;
  /** Original input (preserved for error echoes / logging). */
  raw: string;
};

/**
 * Parse a WS subscription input for the `Provider:identifier` prefix syntax.
 *
 * Recognized prefixes (case-insensitive, via `normalizeProviderAlias`):
 *   - falcon|kite              → kite
 *   - vayu|vortex              → vortex
 *   - atlas|massive|polygon    → massive
 *   - drift|binance            → binance
 *
 * Splits on the FIRST colon only, so `Falcon:NSE:RELIANCE` parses as
 *   { provider: 'kite', identifier: 'NSE:RELIANCE' }
 *
 * Returns `null` (caller falls through to existing resolution) when:
 *   - input is not a string,
 *   - input has no colon,
 *   - input has an empty identifier ("Falcon:"),
 *   - the prefix does not normalize to a known provider (e.g. "NSE:RELIANCE" → null because NSE is not a provider alias).
 */
export function parseProviderPrefix(input: unknown): ProviderPrefixed | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw.length === 0) return null;

  const colonIdx = raw.indexOf(':');
  if (colonIdx <= 0 || colonIdx === raw.length - 1) return null;

  const prefix = raw.slice(0, colonIdx);
  const identifier = raw.slice(colonIdx + 1).trim();
  if (identifier.length === 0) return null;

  const provider = normalizeProviderAlias(prefix);
  if (!provider) return null;

  return { provider, identifier, raw };
}
