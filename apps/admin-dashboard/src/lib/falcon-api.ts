/**
 * @file falcon-api.ts
 * @module admin-dashboard
 * @description Typed API client for Falcon (Kite) admin endpoints under /api/admin/falcon/*.
 * @author BharatERP
 * @created 2026-04-14
 * @updated 2026-04-14 — added shard status, batch historical, options chain admin, cache flush, session health
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

export interface FalconConfigStatus {
  apiKey: { masked: string | null; hasValue: boolean; source: 'redis' | 'env' | 'none' };
  apiSecret: { hasValue: boolean; source: 'redis' | 'env' | 'none' };
  accessToken: { masked: string | null; hasValue: boolean };
  initialized: boolean;
}

export function getFalconConfig() {
  return apiFetch<FalconConfigStatus>('/api/admin/falcon/config', { ...admin });
}

export function updateFalconConfig(body: { apiKey: string; apiSecret?: string }) {
  return apiFetch<{ success: boolean; message: string }>(
    '/api/admin/falcon/config',
    { ...admin, method: 'PATCH', body: JSON.stringify(body) },
  );
}

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

// ─── Batch Historical ──────────────────────────────────────────────────────

export interface FalconBatchHistoricalRequest {
  token: number;
  from: string;
  to: string;
  interval: string;
  continuous?: boolean;
  oi?: boolean;
}

export function postFalconHistoricalBatch(requests: FalconBatchHistoricalRequest[]) {
  return apiFetch<Record<number, { candles?: FalconCandle[]; error?: string }>>(
    '/api/admin/falcon/historical/batch',
    { ...admin, method: 'POST', body: JSON.stringify({ requests }) },
  );
}

// ─── Shard Status ──────────────────────────────────────────────────────────

export interface FalconShardStatus {
  index: number;
  isConnected: boolean;
  subscribedCount: number;
  reconnectAttempts: number;
  reconnectCount: number;
  disableReconnect: boolean;
}

export interface FalconShardStatusResponse {
  shards: FalconShardStatus[];
  totalCapacity: number;
  used: number;
  remaining: number;
  utilizationPct: number;
}

export function getFalconShardStatus() {
  return apiFetch<FalconShardStatusResponse>('/api/admin/falcon/ticker/shards', { ...admin });
}

// ─── Options Chain (Admin) ─────────────────────────────────────────────────

export interface FalconOptionsStrike {
  strike: number;
  ceToken?: number;
  ceLtp?: number | null;
  peToken?: number;
  peLtp?: number | null;
}

export interface FalconOptionsChainResponse {
  symbol: string;
  expiries: string[];
  strikes: FalconOptionsStrike[];
  fetchedAt?: string;
}

export function getFalconOptionsChainAdmin(symbol: string, ltpOnly = false) {
  const q = ltpOnly ? '?ltp_only=true' : '';
  return apiFetch<FalconOptionsChainResponse>(
    `/api/admin/falcon/options/chain/${encodeURIComponent(symbol)}${q}`,
    { ...admin },
  );
}

// ─── Cache Flush ───────────────────────────────────────────────────────────

export interface FlushFalconCacheBody {
  type: 'options' | 'ltp' | 'historical';
  symbol?: string;
  token?: number;
}

export function flushFalconCache(body: FlushFalconCacheBody) {
  return apiFetch<{ deleted: number; message?: string }>(
    '/api/admin/falcon/cache/flush',
    { ...admin, method: 'DELETE', body: JSON.stringify(body) },
  );
}

// ─── Session Health ────────────────────────────────────────────────────────

export interface FalconSessionHealth {
  hasToken: boolean;
  maskedToken: string | null;
  createdAt: number | null;   // ms timestamp
  ttlSeconds: number;          // -2 = missing, -1 = no expiry, 0+ = seconds remaining
  connected: boolean;
  degraded: boolean;
  lastError: { message: string; code?: number; status?: number; time: string } | null;
}

export function getFalconSession() {
  return apiFetch<FalconSessionHealth>('/api/admin/falcon/session', { ...admin });
}

export function revokeFalconSession() {
  return apiFetch<{ message: string }>('/api/admin/falcon/session', { ...admin, method: 'DELETE' });
}

export function postFalconTickerRestart() {
  return apiFetch<{ message: string }>('/api/admin/falcon/ticker/restart', { ...admin, method: 'POST' });
}

/** Admin manual request_token exchange — fallback when OAuth popup fails. */
export function exchangeKiteRequestToken(requestToken: string) {
  return apiFetch<{ success: boolean }>('/api/auth/falcon/exchange', {
    method: 'POST',
    body: JSON.stringify({ requestToken }),
  });
}
