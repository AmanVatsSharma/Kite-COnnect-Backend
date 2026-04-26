import { apiFetch } from './api-client';
import type {
  ApiKeyRow,
  AuditConfig,
  GlobalProviderRes,
  PaginatedAbuse,
  PaginatedUsage,
  StreamStatus,
  WsConfig,
  WsStatus,
} from './types';

const admin = { admin: true as const };

export function listApiKeys() {
  return apiFetch<ApiKeyRow[]>('/api/admin/apikeys', { ...admin });
}

export function createApiKey(body: {
  key: string;
  tenant_id: string;
  name?: string;
  rate_limit_per_minute?: number;
  connection_limit?: number;
  ws_subscribe_rps?: number;
  ws_unsubscribe_rps?: number;
  ws_mode_rps?: number;
  allowed_exchanges?: string[];
}) {
  return apiFetch<ApiKeyRow>('/api/admin/apikeys', {
    ...admin,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function deactivateApiKey(key: string) {
  return apiFetch<{ success: boolean }>('/api/admin/apikeys/deactivate', {
    ...admin,
    method: 'POST',
    body: JSON.stringify({ key }),
  });
}

export function updateApiKeyLimits(body: {
  key: string;
  rate_limit_per_minute?: number;
  connection_limit?: number;
  ws_subscribe_rps?: number | null;
  ws_unsubscribe_rps?: number | null;
  ws_mode_rps?: number | null;
  allowed_exchanges?: string[];
}) {
  return apiFetch<Record<string, unknown>>('/api/admin/apikeys/limits', {
    ...admin,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function getApiKeyLimits(key: string) {
  return apiFetch<Record<string, unknown>>(`/api/admin/apikeys/${encodeURIComponent(key)}/limits`, {
    ...admin,
  });
}

export function getApiKeyUsage(key: string) {
  return apiFetch<Record<string, unknown>>(`/api/admin/apikeys/${encodeURIComponent(key)}/usage`, {
    ...admin,
  });
}

export function listApiKeysUsage(page = 1, pageSize = 50) {
  const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return apiFetch<PaginatedUsage>(`/api/admin/apikeys/usage?${q}`, { ...admin });
}

/** Legacy query-param usage report (same data shape as embedded usage in other endpoints). */
export function getUsageReport(key: string) {
  const q = new URLSearchParams({ key });
  return apiFetch<Record<string, unknown>>(`/api/admin/usage?${q}`, { ...admin });
}

export type AdminProviderName = 'kite' | 'vortex' | 'massive' | 'binance';

export function setApiKeyProvider(body: { key: string; provider?: AdminProviderName | null }) {
  return apiFetch<{ success: boolean }>('/api/admin/apikeys/provider', {
    ...admin,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function setGlobalProvider(provider: AdminProviderName) {
  return apiFetch<{ success: boolean; message?: string }>('/api/admin/provider/global', {
    ...admin,
    method: 'POST',
    body: JSON.stringify({ provider }),
  });
}

export function getGlobalProvider() {
  return apiFetch<GlobalProviderRes>('/api/admin/provider/global', { ...admin });
}

export function startStream() {
  return apiFetch<{ success: boolean; status?: StreamStatus }>('/api/admin/provider/stream/start', {
    ...admin,
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function stopStream() {
  return apiFetch<{ success: boolean }>('/api/admin/provider/stream/stop', {
    ...admin,
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function getStreamStatus() {
  return apiFetch<StreamStatus>('/api/admin/stream/status', { ...admin });
}

export function getWsStatus() {
  return apiFetch<WsStatus>('/api/admin/ws/status', { ...admin });
}

export function getWsConfig() {
  return apiFetch<WsConfig>('/api/admin/ws/config', { ...admin });
}

export function setWsRateLimits(body: {
  subscribe_rps?: number;
  unsubscribe_rps?: number;
  mode_rps?: number;
}) {
  return apiFetch<WsConfig>('/api/admin/ws/rate-limits', {
    ...admin,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function setWsEntitlements(body: { apiKey: string; exchanges: string[] }) {
  return apiFetch<{ success: boolean }>('/api/admin/ws/entitlements', {
    ...admin,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function addWsBlocklist(body: {
  tokens?: number[];
  exchanges?: string[];
  apiKey?: string;
  tenant_id?: string;
  reason?: string;
}) {
  return apiFetch<{ success: boolean }>('/api/admin/ws/blocklist', {
    ...admin,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function flushWsCaches(caches: string[]) {
  return apiFetch<{ success: boolean }>('/api/admin/ws/flush', {
    ...admin,
    method: 'POST',
    body: JSON.stringify({ caches }),
  });
}

export function wsBroadcast(body: { event: string; room?: string; payload: unknown }) {
  return apiFetch<{ success: boolean; message?: string; error?: string }>(
    '/api/admin/ws/namespace/broadcast',
    {
      ...admin,
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

export function getKiteDebug() {
  return apiFetch<Record<string, unknown>>('/api/admin/debug/falcon', { ...admin });
}

export function getVortexDebug() {
  return apiFetch<Record<string, unknown>>('/api/admin/debug/vayu', { ...admin });
}

// ─── Provider credential management ──────────────────────────────────────────

export interface CredKeyStatus { masked: string | null; source: 'db' | 'env' | 'none'; configured?: boolean; hasValue?: boolean }

export interface KiteConfigStatus {
  apiKey: CredKeyStatus;
  apiSecret: CredKeyStatus;
  accessToken: CredKeyStatus;
  initialized: boolean;
}

export interface VayuConfigStatus {
  apiKey: CredKeyStatus;
  baseUrl: { value: string | null; source: 'db' | 'env' | 'none' };
  wsUrl: { value: string | null; source: 'db' | 'env' | 'default' };
  appId: CredKeyStatus;
  initialized: boolean;
  hasAccessToken: boolean;
}

export interface MassiveConfigStatus {
  apiKey: CredKeyStatus;
  realtime: boolean;
  assetClass: string;
  initialized: boolean;
  degraded: boolean;
}

export function getKiteConfig() {
  return apiFetch<KiteConfigStatus>('/api/admin/provider/kite/config', { ...admin });
}

export function setKiteCredentials(body: { apiKey?: string; apiSecret?: string }) {
  return apiFetch<{ success: boolean }>('/api/admin/provider/kite/credentials', {
    ...admin, method: 'POST', body: JSON.stringify(body),
  });
}

export function getVayuConfig() {
  return apiFetch<VayuConfigStatus>('/api/admin/provider/vortex/config', { ...admin });
}

export function updateVayuConfig(body: { apiKey?: string; baseUrl?: string; wsUrl?: string; appId?: string }) {
  return apiFetch<{ success: boolean }>('/api/admin/provider/vortex/credentials', {
    ...admin, method: 'POST', body: JSON.stringify(body),
  });
}

export function getMassiveConfig() {
  return apiFetch<MassiveConfigStatus>('/api/admin/provider/massive/config', { ...admin });
}

export function setMassiveCredentials(body: { apiKey?: string; realtime?: boolean; assetClass?: string }) {
  return apiFetch<{ success: boolean }>('/api/admin/provider/massive/credentials', {
    ...admin, method: 'POST', body: JSON.stringify(body),
  });
}

export function getAuditConfig() {
  return apiFetch<AuditConfig>('/api/admin/audit/config', { ...admin });
}

export function listAbuseFlags(page = 1, pageSize = 50, blocked?: boolean) {
  const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (blocked === true) q.set('blocked', 'true');
  if (blocked === false) q.set('blocked', 'false');
  return apiFetch<PaginatedAbuse>(`/api/admin/abuse/flags?${q}`, { ...admin });
}

export function getAbuseFlag(key: string) {
  return apiFetch<Record<string, unknown>>(
    `/api/admin/abuse/flags/${encodeURIComponent(key)}`,
    { ...admin },
  );
}

export function manualBlockAbuse(body: { api_key: string; reason?: string }) {
  return apiFetch<{ success: boolean }>('/api/admin/abuse/flags/block', {
    ...admin,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function manualUnblockAbuse(body: { api_key: string }) {
  return apiFetch<{ success: boolean }>('/api/admin/abuse/flags/unblock', {
    ...admin,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface AdminStreamEvent {
  type: 'connect' | 'disconnect' | 'auth_error' | 'max_reconnect';
  shardIndex?: number;
  ts: number;
  message: string;
}

export function getAdminEvents(limit = 20) {
  return apiFetch<AdminStreamEvent[]>(`/api/admin/events?limit=${limit}`, { ...admin });
}
