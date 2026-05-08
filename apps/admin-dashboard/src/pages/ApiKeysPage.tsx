/**
 * File:        apps/admin-dashboard/src/pages/ApiKeysPage.tsx
 * Module:      admin-dashboard · API Key Management
 * Purpose:     Enterprise-grade API key management page with live per-key metrics:
 *              live connections, active subscriptions, domain/host breakdown,
 *              bytes transferred (24h), and per-socket session detail.
 *
 * Exports:
 *   - ApiKeysPage() — full-page component
 *
 * Depends on:
 *   - @tanstack/react-query — data fetching and live polling
 *   - ../lib/admin-api — all admin API calls
 *   - ../lib/types — ApiKeyRow, ApiKeyLiveStatsItem, ApiKeyLiveDetail
 *
 * Side-effects:
 *   - Polls /api/admin/apikeys/live-stats every 5 seconds while mounted
 *   - Polls /api/admin/apikeys/:key/live every 5 seconds when detail drawer is open
 *
 * Key invariants:
 *   - liveStatsMap is keyed by API key string — falls back to zeroes when key absent
 *   - Detail drawer tab state is local; resets to 'live' on key change
 *
 * Read order:
 *   1. ApiKeysPage — entry point; sets up queries and state
 *   2. LiveDetailDrawer — tabbed detail panel (Live Sessions | Domains | Limits)
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-08
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, useEffect } from 'react';
import { getAdminToken } from '../lib/api-client';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
import * as admin from '../lib/admin-api';
import type {
  ApiKeyRow,
  ApiKeyUsageItem,
  ApiKeyLiveDetail,
  ApiKeyLiveStatsItem,
  ApiKeyOriginEntry,
  ApiKeySocketEntry,
} from '../lib/types';
import { ErrorInline } from '../components/ErrorInline';
import { KeyValueGrid } from '../components/KeyValueGrid';
import { limitsToRows, usageBundleToRows } from '../lib/views/api-key-views';

// ─── Utility helpers ───────────────────────────────────────────────────────

function fmtNum(n: unknown): string {
  if (typeof n !== 'number') return '—';
  return n.toLocaleString('en-IN');
}

function truncKey(k: string, len = 22) {
  return k.length > len ? `${k.slice(0, len)}…` : k;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function Dot({ on }: { on: boolean }) {
  return <span className={`dot ${on ? 'dot--live' : 'dot--off'}`} />;
}

function LiveBadge({ count }: { count: number }) {
  const color = count > 0 ? 'var(--ok-fg)' : 'var(--muted)';
  return (
    <span
      style={{
        fontFamily: 'monospace',
        fontSize: 11,
        fontWeight: 700,
        color,
        minWidth: 20,
        display: 'inline-block',
        textAlign: 'right',
      }}
    >
      {count}
    </span>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function LiveSessionsTab({ data }: { data: ApiKeyLiveDetail }) {
  if (data.sockets.length === 0) {
    return <p className="cell-muted" style={{ padding: '10px 4px', fontSize: 11 }}>No active WebSocket sessions.</p>;
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table" style={{ fontSize: 10 }}>
        <thead>
          <tr>
            <th>SOCKET ID</th>
            <th>ORIGIN / HOST</th>
            <th>IP</th>
            <th className="cell-num">INSTR</th>
            <th>CONNECTED</th>
            <th>USER AGENT</th>
          </tr>
        </thead>
        <tbody>
          {data.sockets.map((s: ApiKeySocketEntry) => (
            <tr key={s.socketId}>
              <td className="cell-key" title={s.socketId}>{truncKey(s.socketId, 14)}</td>
              <td className="cell-muted" title={s.origin ?? '—'}>{truncKey(s.origin ?? '—', 28)}</td>
              <td className="cell-muted">{s.ip ?? '—'}</td>
              <td className="cell-num" style={{ color: s.instruments > 0 ? 'var(--ok-fg)' : 'var(--muted)' }}>
                {s.instruments}
              </td>
              <td className="cell-muted">{relativeTime(s.connectedAt)}</td>
              <td className="cell-muted" title={s.userAgent ?? '—'} style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.userAgent ? truncKey(s.userAgent, 22) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DomainsTab({ data }: { data: ApiKeyLiveDetail }) {
  const origins = data.topOrigins;
  if (origins.length === 0) {
    return <p className="cell-muted" style={{ padding: '10px 4px', fontSize: 11 }}>No origin data in the last 24 hours.</p>;
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table" style={{ fontSize: 10 }}>
        <thead>
          <tr>
            <th>ORIGIN / DOMAIN</th>
            <th>KIND</th>
            <th className="cell-num">REQUESTS</th>
            <th>LAST SEEN</th>
          </tr>
        </thead>
        <tbody>
          {origins.map((o: ApiKeyOriginEntry, i: number) => (
            <tr key={i}>
              <td title={o.origin ?? 'null'} style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {o.origin ?? <span className="cell-muted">null / direct</span>}
              </td>
              <td>
                <span style={{
                  fontSize: 9,
                  padding: '1px 4px',
                  borderRadius: 3,
                  background: o.kind === 'ws' ? 'var(--ok-bg, rgba(0,200,100,0.12))' : 'var(--warn-bg)',
                  color: o.kind === 'ws' ? 'var(--ok-fg)' : 'var(--warn-fg)',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                }}>
                  {o.kind}
                </span>
              </td>
              <td className="cell-num" style={{ fontWeight: 600 }}>{fmtNum(o.hitCount)}</td>
              <td className="cell-muted">{relativeTime(o.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricsSummaryRow({ data }: { data: ApiKeyLiveDetail }) {
  const items = [
    { label: 'LIVE CONNS', value: fmtNum(data.liveConnections), alert: false },
    { label: 'LIVE SUBS', value: fmtNum(data.liveSubscriptions), alert: false },
    { label: 'BYTES / 24H', value: formatBytes(data.bytesLast24h), alert: false },
    { label: 'HTTP / MIN', value: fmtNum(data.httpRequestsThisMinute), alert: false },
    { label: 'WS CONNS', value: fmtNum(data.currentWsConnections), alert: false },
  ];
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
      {items.map((item) => (
        <div key={item.label} style={{
          background: 'var(--panel-bg)',
          border: '1px solid var(--panel-border)',
          borderRadius: 4,
          padding: '4px 10px',
          minWidth: 80,
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 2 }}>{item.label}</div>
          <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: 'var(--fg)' }}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Live Detail Drawer ───────────────────────────────────────────────────

interface LiveDetailDrawerProps {
  detailKey: string;
  onClose: () => void;
  token: string | null;
  limitsData: Record<string, unknown> | undefined;
  usageData: Record<string, unknown> | undefined;
  limitsError: string | null;
  usageError: string | null;
}

function LiveDetailDrawer({
  detailKey,
  onClose,
  token,
  limitsData,
  usageData,
  limitsError,
  usageError,
}: LiveDetailDrawerProps) {
  const [tab, setTab] = useState<'live' | 'domains' | 'limits'>('live');

  useEffect(() => { setTab('live'); }, [detailKey]);

  const liveDetail = useQuery({
    queryKey: ['admin-key-live', detailKey],
    queryFn: () => admin.getApiKeyLiveDetail(detailKey),
    enabled: !!token && detailKey.length > 0,
    refetchInterval: 5000,
  });

  const tabs: Array<{ id: typeof tab; label: string }> = [
    { id: 'live', label: 'LIVE SESSIONS' },
    { id: 'domains', label: 'DOMAINS (24H)' },
    { id: 'limits', label: 'LIMITS & USAGE' },
  ];

  return (
    <div style={{
      background: 'var(--panel-bg)',
      border: '1px solid var(--panel-border)',
      borderRadius: 6,
      padding: '8px 10px',
      maxHeight: 320,
      overflowY: 'auto',
    }}>
      {/* Drawer header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>
          {detailKey}
        </span>
        <button type="button" className="btn-xs" onClick={onClose}>✕</button>
      </div>

      {/* Metrics summary bar */}
      {liveDetail.data && <MetricsSummaryRow data={liveDetail.data} />}

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 8, borderBottom: '1px solid var(--panel-border)', paddingBottom: 4 }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.06em',
              padding: '2px 7px',
              borderRadius: 3,
              border: '1px solid transparent',
              cursor: 'pointer',
              background: tab === t.id ? 'var(--accent, #1c7ed6)' : 'transparent',
              color: tab === t.id ? '#fff' : 'var(--muted)',
              transition: 'background 0.1s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'live' && (
        <div>
          <ErrorInline message={liveDetail.isError ? (liveDetail.error as Error).message : null} />
          {liveDetail.isLoading && <p className="cell-muted" style={{ fontSize: 11 }}>Loading live sessions…</p>}
          {liveDetail.data && <LiveSessionsTab data={liveDetail.data} />}
        </div>
      )}

      {tab === 'domains' && (
        <div>
          <ErrorInline message={liveDetail.isError ? (liveDetail.error as Error).message : null} />
          {liveDetail.isLoading && <p className="cell-muted" style={{ fontSize: 11 }}>Loading domain data…</p>}
          {liveDetail.data && <DomainsTab data={liveDetail.data} />}
        </div>
      )}

      {tab === 'limits' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <div className="panel-section-title">LIMITS</div>
            <ErrorInline message={limitsError} />
            {limitsData && (
              <KeyValueGrid
                rows={limitsToRows(limitsData).map((r) => ({ label: r.label, value: r.value }))}
              />
            )}
          </div>
          <div>
            <div className="panel-section-title">USAGE BUNDLE</div>
            <ErrorInline message={usageError} />
            {usageData && (
              <KeyValueGrid
                rows={usageBundleToRows(usageData).map((r) => ({ label: r.label, value: r.value }))}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────

export function ApiKeysPage() {
  const token = getAdminToken();
  const qc = useQueryClient();
  const { refetchInterval, recordFetchLatency } = useRefreshInterval();
  const [page, setPage] = useState(1);
  const [nk, setNk] = useState({ key: '', tenant_id: 'default', rate_limit_per_minute: 600, connection_limit: 2000 });
  const [limitKey, setLimitKey] = useState('');
  const [limitBody, setLimitBody] = useState('{"rate_limit_per_minute":600}');
  const [provKey, setProvKey] = useState('');
  const [prov, setProv] = useState<'kite' | 'vortex' | 'massive' | 'binance' | 'inherit'>('inherit');
  const [detailKey, setDetailKey] = useState('');
  const [copied, setCopied] = useState('');

  const listKeys = useCallback(async () => {
    const t0 = performance.now();
    try { return await admin.listApiKeys(); }
    finally { recordFetchLatency(Math.round(performance.now() - t0)); }
  }, [recordFetchLatency]);

  const listUsagePage = useCallback(async () => {
    const t0 = performance.now();
    try { return await admin.listApiKeysUsage(page, 50); }
    finally { recordFetchLatency(Math.round(performance.now() - t0)); }
  }, [page, recordFetchLatency]);

  const keys       = useQuery({ queryKey: ['admin-apikeys'], queryFn: listKeys, enabled: !!token, refetchInterval });
  const usage      = useQuery({ queryKey: ['admin-apikeys-usage', page], queryFn: listUsagePage, enabled: !!token, refetchInterval });
  const liveStats  = useQuery({
    queryKey: ['admin-apikeys-live-stats'],
    queryFn: admin.getApiKeyLiveStatsBatch,
    enabled: !!token,
    refetchInterval: 5000,
  });

  const create      = useMutation({ mutationFn: admin.createApiKey,    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-apikeys'] }) });
  const deactivate  = useMutation({ mutationFn: admin.deactivateApiKey,onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-apikeys'] }) });
  const patchLimits = useMutation({ mutationFn: (b: Parameters<typeof admin.updateApiKeyLimits>[0]) => admin.updateApiKeyLimits(b), onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-apikeys'] }) });
  const setProvider = useMutation({ mutationFn: admin.setApiKeyProvider, onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-apikeys'] }) });

  const limitsDetail  = useQuery({ queryKey: ['admin-key-limits', detailKey],  queryFn: () => admin.getApiKeyLimits(detailKey),  enabled: !!token && detailKey.length > 0 });
  const usageDetail   = useQuery({ queryKey: ['admin-key-usage', detailKey],   queryFn: () => admin.getApiKeyUsage(detailKey),   enabled: !!token && detailKey.length > 0 });

  if (!token) {
    return (
      <section className="card">
        <p className="err">Add an admin token in Settings.</p>
      </section>
    );
  }

  /* Lookup maps */
  const usageMap = new Map<string, ApiKeyUsageItem>();
  usage.data?.items.forEach((u) => usageMap.set(u.key, u));

  const liveMap = new Map<string, ApiKeyLiveStatsItem>();
  liveStats.data?.items.forEach((l) => liveMap.set(l.key, l));

  const keyList: ApiKeyRow[] = Array.isArray(keys.data) ? keys.data : [];

  function generateTrial() {
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    create.mutate({
      key: `trial-${randomSuffix}`,
      tenant_id: `tenant-trial-${randomSuffix}`,
      name: `Trial Key (${randomSuffix})`,
      is_test: true,
      rate_limit_per_minute: 100,
      connection_limit: 10,
    });
  }

  function copyKey(k: string) {
    void navigator.clipboard.writeText(k).then(() => {
      setCopied(k);
      setTimeout(() => setCopied(''), 1500);
    });
  }

  function submitLimits() {
    let extra: Record<string, unknown>;
    try { extra = JSON.parse(limitBody) as Record<string, unknown>; }
    catch { alert('Limits JSON invalid'); return; }
    patchLimits.mutate({ key: limitKey, ...extra } as Parameters<typeof admin.updateApiKeyLimits>[0]);
  }

  const totalPages = usage.data ? Math.max(1, Math.ceil(usage.data.total / usage.data.pageSize)) : 1;
  const totalLiveConns = liveStats.data?.totalLiveConnections ?? 0;

  return (
    <div className="keys-layout" style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* ── Page header ─────────────────────────────────────── */}
      <div className="page-head">
        <h1>API KEY MANAGEMENT</h1>
        <div className="page-head-actions">
          {/* Live connections indicator */}
          {totalLiveConns > 0 && (
            <span style={{
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--ok-fg)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}>
              <span className="dot dot--live" />
              {totalLiveConns} live
            </span>
          )}
          <span className="muted" style={{ fontSize: 11 }}>
            {usage.data ? `${usage.data.total} keys` : '…'}
          </span>
          <button
            type="button"
            className="btn-xs"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >← Prev</button>
          <span className="muted" style={{ fontSize: 10 }}>
            {page} / {totalPages}
          </span>
          <button
            type="button"
            className="btn-xs"
            disabled={!usage.data || page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >Next →</button>
        </div>
      </div>

      {/* ── Dense keys table ────────────────────────────────── */}
      <div className="keys-table-wrap" style={{ flex: 2, minHeight: 0 }}>
        <ErrorInline message={keys.isError ? (keys.error as Error).message : null} />
        <table className="data-table">
          <thead>
            <tr>
              <th>KEY</th>
              <th>NAME / TENANT</th>
              <th style={{ width: 30 }}>ST</th>
              <th className="cell-num" title="HTTP rate limit / minute">RATE/m</th>
              <th className="cell-num" title="Connection limit">CONN LIM</th>
              <th>PROV</th>
              {/* Live columns */}
              <th className="cell-num" title="Live WebSocket connections right now">LIVE WS</th>
              <th className="cell-num" title="Total subscribed instruments across live connections">LIVE SUBS</th>
              <th className="cell-num" title="Bytes broadcast to this key in last 24h">BYTES/24H</th>
              {/* HTTP usage */}
              <th style={{ minWidth: 90 }} title="HTTP requests this minute vs limit">HTTP / MIN</th>
              <th>CREATED</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {keyList.map((k) => {
              const u = usageMap.get(k.key);
              const live = liveMap.get(k.key);
              const httpReq = typeof u?.usage?.http_requests === 'number' ? (u.usage.http_requests as number) : 0;
              const rateLimit = k.rate_limit_per_minute ?? 600;
              const usagePct = Math.min(100, Math.round((httpReq / rateLimit) * 100));
              const barVariant = usagePct > 80 ? 'bad' : usagePct > 50 ? 'warn' : 'ok';
              const createdDate = k.created_at
                ? new Date(k.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
                : '—';
              const liveConns = live?.liveConnections ?? 0;
              const liveSubs = live?.liveSubscriptions ?? 0;
              const bytes24h = live?.bytesLast24h ?? 0;

              return (
                <tr key={k.key} style={{ opacity: k.is_active ? 1 : 0.5 }}>
                  {/* KEY */}
                  <td>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <span className="cell-key" title={k.key}>{truncKey(k.key)}</span>
                      {k.is_test && (
                        <span
                          style={{
                            fontSize: 8,
                            padding: '1px 3px',
                            borderRadius: 3,
                            background: 'var(--warn-bg)',
                            color: 'var(--warn-fg)',
                            fontWeight: 700,
                            lineHeight: 1,
                          }}
                          title={k.expires_at ? `Expires: ${new Date(k.expires_at).toLocaleString()}` : 'Trial key'}
                        >
                          TRIAL
                        </span>
                      )}
                      <button type="button" className="btn-icon" onClick={() => copyKey(k.key)} title="Copy full key">
                        {copied === k.key ? '✓' : '⧉'}
                      </button>
                    </span>
                  </td>
                  {/* NAME / TENANT */}
                  <td>
                    <div className="cell-name" title={k.name ?? undefined} style={{ fontSize: 11 }}>{k.name ?? '—'}</div>
                    <div className="cell-muted" style={{ fontSize: 9 }}>{k.tenant_id}</div>
                  </td>
                  {/* STATUS */}
                  <td style={{ textAlign: 'center' }}><Dot on={k.is_active} /></td>
                  {/* RATE / CONN */}
                  <td className="cell-num">{fmtNum(k.rate_limit_per_minute)}</td>
                  <td className="cell-num">{fmtNum(k.connection_limit)}</td>
                  {/* PROVIDER */}
                  <td className="cell-muted" style={{ fontSize: 10 }}>{k.provider ?? 'inherit'}</td>
                  {/* LIVE WS */}
                  <td className="cell-num">
                    {liveConns > 0 ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 3, justifyContent: 'flex-end' }}>
                        <span className="dot dot--live" />
                        <LiveBadge count={liveConns} />
                      </span>
                    ) : (
                      <LiveBadge count={0} />
                    )}
                  </td>
                  {/* LIVE SUBS */}
                  <td className="cell-num">
                    <LiveBadge count={liveSubs} />
                  </td>
                  {/* BYTES 24H */}
                  <td className="cell-num" style={{ fontSize: 10, color: bytes24h > 0 ? 'var(--fg)' : 'var(--muted)' }}>
                    {bytes24h > 0 ? formatBytes(bytes24h) : '—'}
                  </td>
                  {/* HTTP USAGE BAR */}
                  <td style={{ minWidth: 90 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span className="cell-num" style={{ minWidth: 32 }}>{fmtNum(httpReq)}</span>
                      <div className={`usage-bar usage-bar--${barVariant}`} style={{ flex: 1 }}>
                        <div className="usage-bar__fill" style={{ width: `${usagePct}%` }} />
                      </div>
                    </div>
                  </td>
                  {/* CREATED */}
                  <td className="cell-muted" style={{ fontSize: 10 }}>{createdDate}</td>
                  {/* ACTIONS */}
                  <td>
                    <span style={{ display: 'flex', gap: 3 }}>
                      <button
                        type="button"
                        className="btn-xs"
                        onClick={() => setDetailKey(detailKey === k.key ? '' : k.key)}
                        title="View live detail"
                      >
                        {detailKey === k.key ? '▲' : 'Detail'}
                      </button>
                      <button
                        type="button"
                        className="btn-xs"
                        onClick={() => setLimitKey(k.key)}
                        title="Edit limits"
                      >
                        Lim
                      </button>
                      {k.is_active && (
                        <button
                          type="button"
                          className="btn-xs btn-xs--danger"
                          onClick={() => deactivate.mutate(k.key)}
                          disabled={deactivate.isPending}
                        >
                          Off
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
            {keyList.length === 0 && (
              <tr>
                <td colSpan={12} className="cell-muted" style={{ textAlign: 'center', padding: '16px 8px' }}>
                  {keys.isLoading ? 'Loading…' : 'No API keys found'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Live detail drawer ───────────────────────────────── */}
      {detailKey && (
        <LiveDetailDrawer
          detailKey={detailKey}
          onClose={() => setDetailKey('')}
          token={token}
          limitsData={limitsDetail.data as Record<string, unknown> | undefined}
          usageData={usageDetail.data as Record<string, unknown> | undefined}
          limitsError={limitsDetail.isError ? (limitsDetail.error as Error).message : null}
          usageError={usageDetail.isError ? (usageDetail.error as Error).message : null}
        />
      )}

      {/* ── Compact action forms ─────────────────────────────── */}
      <div className="keys-forms-grid">
        {/* Create key */}
        <div className="keys-form-card">
          <div className="keys-form-card__title">CREATE API KEY</div>
          <div className="keys-form-row">
            <div>
              <label>Key</label>
              <input value={nk.key} onChange={(e) => setNk({ ...nk, key: e.target.value })} placeholder="my-key-1" />
            </div>
            <div>
              <label>Tenant</label>
              <input value={nk.tenant_id} onChange={(e) => setNk({ ...nk, tenant_id: e.target.value })} />
            </div>
          </div>
          <div className="keys-form-row">
            <div>
              <label>Rate/min</label>
              <input type="number" value={nk.rate_limit_per_minute} onChange={(e) => setNk({ ...nk, rate_limit_per_minute: Number(e.target.value) })} />
            </div>
            <div>
              <label>Conn limit</label>
              <input type="number" value={nk.connection_limit} onChange={(e) => setNk({ ...nk, connection_limit: Number(e.target.value) })} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="btn-xs"
              style={{ flex: 1 }}
              disabled={create.isPending || !nk.key}
              onClick={() => create.mutate({ ...nk, is_test: false })}
            >
              {create.isPending ? 'Creating…' : '+ Create key'}
            </button>
            <button
              type="button"
              className="btn-xs"
              style={{ flex: 1, border: '1px solid var(--warn-fg)', color: 'var(--warn-fg)' }}
              disabled={create.isPending}
              onClick={generateTrial}
              title="Generate a 7-day trial key with 1-click"
            >
              {create.isPending ? 'Working…' : '⚡ 7-Day Trial'}
            </button>
          </div>
          {create.isError && <p className="err" style={{ fontSize: 10, marginTop: 4 }}>{(create.error as Error).message}</p>}
        </div>

        {/* Update limits */}
        <div className="keys-form-card">
          <div className="keys-form-card__title">UPDATE LIMITS (JSON)</div>
          <div className="keys-form-row" style={{ marginBottom: 4 }}>
            <div>
              <label>Key ID</label>
              <input value={limitKey} onChange={(e) => setLimitKey(e.target.value)} placeholder="api-key-id" />
            </div>
          </div>
          <label style={{ fontSize: 10, marginBottom: 2 }}>JSON body</label>
          <textarea value={limitBody} onChange={(e) => setLimitBody(e.target.value)} style={{ minHeight: 48, fontSize: 11, padding: '4px 6px' }} />
          <button type="button" className="btn-xs" style={{ marginTop: 4 }} disabled={patchLimits.isPending || !limitKey} onClick={submitLimits}>
            {patchLimits.isPending ? 'Saving…' : 'Apply limits'}
          </button>
          {patchLimits.isError && <p className="err" style={{ fontSize: 10, marginTop: 4 }}>{(patchLimits.error as Error).message}</p>}
        </div>

        {/* Provider override */}
        <div className="keys-form-card">
          <div className="keys-form-card__title">PROVIDER OVERRIDE</div>
          <div className="keys-form-row">
            <div>
              <label>Key</label>
              <input value={provKey} onChange={(e) => setProvKey(e.target.value)} placeholder="api-key-id" />
            </div>
            <div>
              <label>Provider</label>
              <select value={prov} onChange={(e) => setProv(e.target.value as typeof prov)} style={{ fontSize: 11, padding: '4px 6px' }}>
                <option value="inherit">inherit (null)</option>
                <option value="kite">Falcon</option>
                <option value="vortex">Vayu</option>
                <option value="massive">Atlas</option>
                <option value="binance">Drift</option>
              </select>
            </div>
          </div>
          <button
            type="button"
            className="btn-xs"
            disabled={setProvider.isPending || !provKey}
            onClick={() => setProvider.mutate({ key: provKey, provider: prov === 'inherit' ? null : prov })}
          >
            {setProvider.isPending ? 'Saving…' : 'Save provider'}
          </button>
        </div>
      </div>
    </div>
  );
}
