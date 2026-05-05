/**
 * @file apps/admin-dashboard/src/lib/search-api.ts
 * @module admin-dashboard
 * @description Typed client for the search-api microservice (/api/search).
 *              The search-api runs on port 3002 but is proxied by nginx at /api/search,
 *              so all requests go to the same origin — no CORS configuration needed.
 *
 * Exports:
 *   - PublicProviderName        — public brand names (falcon | vayu | atlas | drift)
 *   - StreamProviderName        — internal provider name union (kite | vortex | massive | binance)
 *   - SearchResultItem          — shape of one search result row (admin-extended fields included)
 *   - SearchFilters             — filter parameters accepted by searchInstruments
 *   - SearchAdminOverview       — shape returned by /api/search/admin/overview
 *   - searchInstruments(...)    — GET /api/search (admin variant by default for the dashboard)
 *   - suggestInstruments(...)   — GET /api/search/suggest
 *   - getFacets(...)            — GET /api/search/filters
 *   - getSearchAdminOverview()  — GET /api/search/admin/overview
 *
 * Side-effects:
 *   - HTTP GET requests to /api/search/* (admin endpoints add x-admin-token header)
 *
 * Key invariants:
 *   - `wsSubscribeUirId` is always equal to `id` — clients should pass it in the
 *     /ws subscribe payload as `{event:"subscribe", data:{instruments:[<id>], mode:"ltp"}}`
 *   - Public clients receive `streamProvider` as a public brand name
 *     (`'falcon' | 'vayu' | 'atlas' | 'drift'`). Admin callers (this dashboard)
 *     additionally receive `_internalProvider` and the *Token fields when they
 *     pass `?include=internal` + `x-admin-token`.
 *   - `streamProvider` is a routing fact (which provider streams this instrument's
 *     live ticks). Frontends should NOT derive subscribe routing from it — always
 *     subscribe by UIR id and let the backend route per-instrument.
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-01
 */

import { apiUrl } from './api-base';
import { getAdminToken } from './api-client';

/** Public brand names exposed in /api/search responses (default). */
export type PublicProviderName = 'falcon' | 'vayu' | 'atlas' | 'drift';

/**
 * Internal provider names — only present in admin responses (when ?include=internal
 * is passed with the admin token). The public default response NEVER carries these.
 */
export type StreamProviderName = 'kite' | 'vortex' | 'massive' | 'binance';

/** Display info for a public provider brand — used in the SearchPage VIA badge. */
export const PUBLIC_PROVIDER_LABELS: Record<
  PublicProviderName,
  { name: string; color: string; bg: string; covers: string }
> = {
  falcon: {
    name: 'Falcon',
    color: '#f59e0b',
    bg: 'rgba(245, 158, 11, 0.15)',
    covers: 'Indian equity (NSE/BSE)',
  },
  vayu: {
    name: 'Vayu',
    color: '#818cf8',
    bg: 'rgba(99, 102, 241, 0.15)',
    covers: 'F&O / currency / commodities',
  },
  atlas: {
    name: 'Atlas',
    color: '#34d399',
    bg: 'rgba(16, 185, 129, 0.15)',
    covers: 'US stocks / forex / options',
  },
  drift: {
    name: 'Drift',
    color: '#facc15',
    bg: 'rgba(234, 179, 8, 0.15)',
    covers: 'Global crypto Spot',
  },
};

export type SearchResultItem = {
  id: number;
  canonicalSymbol: string;
  symbol?: string;
  name?: string;
  exchange?: string;
  segment?: string;
  instrumentType?: string;
  assetClass?: string;
  optionType?: string | null;
  expiry?: string | null;
  strike?: number | null;
  lotSize?: number;
  tickSize?: number;
  isDerivative?: boolean;
  underlyingSymbol?: string;
  /** Public brand name. Always present for both public and admin responses. */
  streamProvider?: PublicProviderName;
  /** Alias of `id` — explicit "subscribe with this id via /ws" hint. */
  wsSubscribeUirId?: number;
  last_price?: number | null;
  /** 'live' = last_price > 0; 'stale' = no live price (off-hours / no mapping / delisted). */
  priceStatus?: 'live' | 'stale';

  // ── Admin-only fields (populated only when ?include=internal + x-admin-token) ──
  /** Raw internal provider name (kite/vortex/massive/binance) — admin only. */
  _internalProvider?: StreamProviderName;
  kiteToken?: number;
  vortexToken?: number;
  vortexExchange?: string;
  /** Massive symbol (e.g. "AAPL", "EURUSD"). Admin only. */
  massiveToken?: string;
  /** Binance Spot symbol (e.g. "BTCUSDT"). Admin only. */
  binanceToken?: string;
};

export type SearchFilters = {
  exchange?: string;
  segment?: string;
  instrumentType?: string;
  vortexExchange?: string;
  optionType?: string;
  assetClass?: string;
  /** Accepts public brand names (falcon/vayu/atlas/drift) or internal canonicals. */
  streamProvider?: PublicProviderName | StreamProviderName;
  mode?: 'eq' | 'fno' | 'curr' | 'commodities';
  ltp_only?: boolean;
  /** Comma-separated allow-list of public fields to return. */
  fields?: string;
};

type SearchResponse = {
  success: boolean;
  data: SearchResultItem[];
  timestamp: string;
};

/**
 * Whether to call the admin variant. The dashboard is admin-only, so it defaults
 * to `true` — we want the VIA badge to show the real internal provider name and
 * the *Token columns to render in the debug view. Components for end-user views
 * (if/when they get embedded into a non-admin shell) should pass `admin: false`.
 */
async function fetchSearch(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  opts: { admin?: boolean } = {},
): Promise<SearchResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const useAdmin = opts.admin !== false;
  if (useAdmin) qs.set('include', 'internal');

  const headers = new Headers();
  if (useAdmin) {
    const t = getAdminToken();
    if (t) headers.set('x-admin-token', t);
  }

  const url = `${apiUrl(path)}?${qs.toString()}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Search API ${res.status}: ${await res.text()}`);
  return res.json();
}

export function searchInstruments(
  q: string,
  limit = 20,
  filters: SearchFilters = {},
  opts: { admin?: boolean } = {},
): Promise<SearchResponse> {
  return fetchSearch('/api/search', { q, limit, ...filters }, opts);
}

export function suggestInstruments(
  q: string,
  limit = 5,
  filters: SearchFilters = {},
  opts: { admin?: boolean } = {},
): Promise<SearchResponse> {
  return fetchSearch('/api/search/suggest', { q, limit, ...filters }, opts);
}

export function getFacets(
  filters: Omit<SearchFilters, 'ltp_only' | 'mode' | 'fields'> = {},
): Promise<{
  success: boolean;
  data: Record<string, Record<string, number>>;
  timestamp: string;
}> {
  return fetchSearch('/api/search/filters', filters) as any;
}

// ── Search Admin overview ────────────────────────────────────────────────────

export type SearchAdminOverview = {
  meili: {
    indexName: string;
    numberOfDocuments: number | null;
    isIndexing: boolean | null;
    fieldDistribution: Record<string, number> | null;
    settings: {
      searchableAttributes: string[] | null;
      filterableAttributes: string[] | null;
      sortableAttributes: string[] | null;
      synonymCount: number | null;
    };
  };
  selectionSignals: {
    scanned: number;
    top: { q: string; symbol: string; count: number }[];
  };
  popularQueries: {
    q: string;
    totalSelections: number;
    uniqueSymbols: number;
  }[];
  errors: string[];
  generatedAt: string;
};

export async function getSearchAdminOverview(topN = 30): Promise<{
  success: boolean;
  data: SearchAdminOverview;
}> {
  const headers = new Headers();
  const t = getAdminToken();
  if (t) headers.set('x-admin-token', t);
  const res = await fetch(apiUrl(`/api/search/admin/overview?topN=${topN}`), {
    headers,
  });
  if (!res.ok)
    throw new Error(`Search Admin ${res.status}: ${await res.text()}`);
  return res.json();
}
