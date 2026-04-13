/**
 * @file falcon-api.ts
 * @module admin-dashboard
 * @description Typed API client for Falcon (Kite) admin endpoints under /api/admin/falcon/*.
 * @author BharatERP
 * @created 2026-04-14
 * @updated 2026-04-14
 */
import { apiFetch } from './api-client';
import type {
  FalconInstrument,
  FalconStats,
  FalconQuote,
  FalconCandle,
  KiteProfile,
  KiteMargins,
} from './types';

const admin = { admin: true as const };

export function getFalconProfile() {
  return apiFetch<KiteProfile>('/api/admin/falcon/profile', { ...admin });
}

export function getFalconMargins(segment?: 'equity' | 'commodity') {
  const q = segment ? `?segment=${segment}` : '';
  return apiFetch<KiteMargins>(`/api/admin/falcon/margins${q}`, { ...admin });
}

export function getFalconStats() {
  return apiFetch<FalconStats>('/api/admin/falcon/stats', { ...admin });
}

export interface FalconInstrumentsParams {
  exchange?: string;
  instrument_type?: string;
  segment?: string;
  is_active?: boolean;
  limit?: number;
  offset?: number;
}

export function getFalconInstruments(params: FalconInstrumentsParams = {}) {
  const q = new URLSearchParams();
  if (params.exchange) q.set('exchange', params.exchange);
  if (params.instrument_type) q.set('instrument_type', params.instrument_type);
  if (params.segment) q.set('segment', params.segment);
  if (params.is_active !== undefined) q.set('is_active', String(params.is_active));
  if (params.limit !== undefined) q.set('limit', String(params.limit));
  if (params.offset !== undefined) q.set('offset', String(params.offset));
  const qs = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ instruments: FalconInstrument[]; total: number }>(
    `/api/admin/falcon/instruments${qs}`,
    { ...admin },
  );
}

export function searchFalconInstruments(q: string, limit = 20) {
  const params = new URLSearchParams({ q, limit: String(limit) });
  return apiFetch<FalconInstrument[]>(`/api/admin/falcon/instruments/search?${params}`, { ...admin });
}

export function syncFalconInstruments(exchange?: string) {
  return apiFetch<{ synced: number; updated: number; reconciled?: number }>(
    '/api/admin/falcon/instruments/sync',
    {
      ...admin,
      method: 'POST',
      body: JSON.stringify({ exchange: exchange || undefined }),
    },
  );
}

export function getFalconSyncStatus(jobId: string) {
  return apiFetch<{ jobId: string; status: any }>(
    `/api/admin/falcon/instruments/sync/status?jobId=${encodeURIComponent(jobId)}`,
    { ...admin },
  );
}

export function getFalconLTP(tokens: string[]) {
  return apiFetch<Record<string, { last_price: number | null }>>(
    '/api/admin/falcon/ltp',
    { ...admin, method: 'POST', body: JSON.stringify({ tokens }) },
  );
}

export function getFalconQuote(tokens: string[]) {
  return apiFetch<Record<string, FalconQuote>>(
    '/api/admin/falcon/quote',
    { ...admin, method: 'POST', body: JSON.stringify({ tokens }) },
  );
}

export function getFalconOHLC(tokens: string[]) {
  return apiFetch<Record<string, { last_price: number; ohlc: { open: number; high: number; low: number; close: number } }>>(
    '/api/admin/falcon/ohlc',
    { ...admin, method: 'POST', body: JSON.stringify({ tokens }) },
  );
}

export function getFalconHistorical(
  token: string,
  from: string,
  to: string,
  interval: string,
  continuous = false,
  oi = false,
) {
  const q = new URLSearchParams({ from, to, interval });
  if (continuous) q.set('continuous', 'true');
  if (oi) q.set('oi', 'true');
  return apiFetch<{ candles: FalconCandle[] }>(
    `/api/admin/falcon/historical/${encodeURIComponent(token)}?${q}`,
    { ...admin },
  );
}
