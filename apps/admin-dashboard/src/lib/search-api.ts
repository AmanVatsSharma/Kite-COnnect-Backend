/**
 * @file apps/admin-dashboard/src/lib/search-api.ts
 * @module admin-dashboard
 * @description Typed client for the search-api microservice (/api/search).
 *              The search-api runs on port 3002 but is proxied by nginx at /api/search,
 *              so all requests go to the same origin — no CORS configuration needed.
 *
 * Exports:
 *   - SearchResultItem      — shape of one search result document
 *   - SearchFilters         — filter parameters accepted by searchInstruments
 *   - searchInstruments(p)  — GET /api/search
 *   - suggestInstruments(p) — GET /api/search/suggest
 *   - getFacets(p)          — GET /api/search/filters
 *
 * Side-effects:
 *   - HTTP GET requests to /api/search (no auth required)
 *
 * Author:      BharatERP
 * Last-updated: 2026-04-25
 */

import { apiUrl } from './api-base';

export type SearchResultItem = {
  id: number;
  canonicalSymbol: string;
  symbol: string;
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
  kiteToken?: number;
  vortexToken?: number;
  vortexExchange?: string;
  last_price?: number | null;
};

export type SearchFilters = {
  exchange?: string;
  segment?: string;
  instrumentType?: string;
  vortexExchange?: string;
  optionType?: string;
  assetClass?: string;
  mode?: 'eq' | 'fno' | 'curr' | 'commodities';
  ltp_only?: boolean;
};

type SearchResponse = { success: boolean; data: SearchResultItem[]; timestamp: string };

async function fetchSearch(path: string, params: Record<string, string | number | boolean | undefined>): Promise<SearchResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const url = `${apiUrl(path)}?${qs.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Search API ${res.status}: ${await res.text()}`);
  return res.json();
}

export function searchInstruments(
  q: string,
  limit = 20,
  filters: SearchFilters = {},
): Promise<SearchResponse> {
  return fetchSearch('/api/search', { q, limit, ...filters });
}

export function suggestInstruments(
  q: string,
  limit = 5,
  filters: SearchFilters = {},
): Promise<SearchResponse> {
  return fetchSearch('/api/search/suggest', { q, limit, ...filters });
}

export function getFacets(filters: Omit<SearchFilters, 'ltp_only' | 'mode'> = {}): Promise<{
  success: boolean;
  data: Record<string, Record<string, number>>;
  timestamp: string;
}> {
  return fetchSearch('/api/search/filters', filters) as any;
}
