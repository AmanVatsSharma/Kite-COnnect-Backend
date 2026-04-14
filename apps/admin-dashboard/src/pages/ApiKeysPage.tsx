/**
 * @file ApiKeysPage.tsx
 * @module admin-dashboard
 * @description API key management: dense table with live usage bars + compact action forms.
 * @author BharatERP
 * @created 2026-03-28
 * @updated 2026-04-14
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { getAdminToken } from '../lib/api-client';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
import * as admin from '../lib/admin-api';
import type { ApiKeyRow, ApiKeyUsageItem } from '../lib/types';
import { ErrorInline } from '../components/ErrorInline';
import { RawJsonDetails } from '../components/RawJsonDetails';
import { KeyValueGrid } from '../components/KeyValueGrid';
import { limitsToRows, usageBundleToRows } from '../lib/views/api-key-views';
import { flattenObject } from '../lib/views/flatten';

function fmtNum(n: unknown): string {
  if (typeof n !== 'number') return '—';
  return n.toLocaleString('en-IN');
}

function truncKey(k: string, len = 22) {
  return k.length > len ? `${k.slice(0, len)}…` : k;
}

function Dot({ on }: { on: boolean }) {
  return <span className={`dot ${on ? 'dot--live' : 'dot--off'}`} />;
}

export function ApiKeysPage() {
  const token = getAdminToken();
  const qc = useQueryClient();
  const { refetchInterval, recordFetchLatency } = useRefreshInterval();
  const [page, setPage] = useState(1);
  const [nk, setNk] = useState({ key: '', tenant_id: 'default', rate_limit_per_minute: 600, connection_limit: 2000 });
  const [limitKey, setLimitKey] = useState('');
  const [limitBody, setLimitBody] = useState('{"rate_limit_per_minute":600}');
  const [provKey, setProvKey] = useState('');
  const [prov, setProv] = useState<'kite' | 'vortex' | 'inherit'>('inherit');
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

  const keys = useQuery({ queryKey: ['admin-apikeys'], queryFn: listKeys, enabled: !!token, refetchInterval });
  const usage = useQuery({ queryKey: ['admin-apikeys-usage', page], queryFn: listUsagePage, enabled: !!token, refetchInterval });

  const create    = useMutation({ mutationFn: admin.createApiKey,    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-apikeys'] }) });
  const deactivate= useMutation({ mutationFn: admin.deactivateApiKey,onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-apikeys'] }) });
  const patchLimits = useMutation({ mutationFn: (b: Parameters<typeof admin.updateApiKeyLimits>[0]) => admin.updateApiKeyLimits(b), onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-apikeys'] }) });
  const setProvider = useMutation({ mutationFn: admin.setApiKeyProvider, onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-apikeys'] }) });

  const limitsDetail  = useQuery({ queryKey: ['admin-key-limits', detailKey],  queryFn: () => admin.getApiKeyLimits(detailKey),  enabled: !!token && detailKey.length > 0 });
  const usageDetail   = useQuery({ queryKey: ['admin-key-usage', detailKey],   queryFn: () => admin.getApiKeyUsage(detailKey),   enabled: !!token && detailKey.length > 0 });
  const usageReportQ  = useQuery({ queryKey: ['admin-usage-report', detailKey],queryFn: () => admin.getUsageReport(detailKey),   enabled: !!token && detailKey.length > 0 });

  if (!token) {
    return (
      <section className="card">
        <p className="err">Add an admin token in Settings.</p>
      </section>
    );
  }

  /* Build usage lookup map */
  const usageMap = new Map<string, ApiKeyUsageItem>();
  usage.data?.items.forEach((u) => usageMap.set(u.key, u));
  const keyList: ApiKeyRow[] = Array.isArray(keys.data) ? keys.data : [];

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

  return (
    <div className="keys-layout" style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* ── Page header ─────────────────────────────────────── */}
      <div className="page-head">
        <h1>API KEY MANAGEMENT</h1>
        <div className="page-head-actions">
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
              <th>NAME</th>
              <th>TENANT</th>
              <th style={{ width: 30 }}>ST</th>
              <th className="cell-num">RATE/m</th>
              <th className="cell-num">WS SUB</th>
              <th className="cell-num">WS UNSUB</th>
              <th className="cell-num">CONN LIM</th>
              <th>PROV</th>
              <th>HTTP USAGE</th>
              <th>CREATED</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {keyList.map((k) => {
              const u = usageMap.get(k.key);
              const httpReq = typeof u?.usage?.http_requests === 'number' ? u.usage.http_requests as number : 0;
              const rateLimit = k.rate_limit_per_minute ?? 600;
              const usagePct = Math.min(100, Math.round((httpReq / rateLimit) * 100));
              const barVariant = usagePct > 80 ? 'bad' : usagePct > 50 ? 'warn' : 'ok';
              const wsConns = typeof u?.usage?.ws_connections === 'number' ? u.usage.ws_connections as number : null;
              const createdDate = k.created_at ? new Date(k.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—';

              return (
                <tr key={k.key} style={{ opacity: k.is_active ? 1 : 0.5 }}>
                  <td>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <span className="cell-key" title={k.key}>{truncKey(k.key)}</span>
                      <button
                        type="button"
                        className="copy-btn"
                        onClick={() => copyKey(k.key)}
                        title="Copy key"
                      >
                        {copied === k.key ? '✓' : '⎘'}
                      </button>
                    </span>
                  </td>
                  <td className="cell-name" title={k.name ?? undefined}>{k.name ?? '—'}</td>
                  <td className="cell-muted" title={k.tenant_id}>{k.tenant_id}</td>
                  <td style={{ textAlign: 'center' }}><Dot on={k.is_active} /></td>
                  <td className="cell-num">{fmtNum(k.rate_limit_per_minute)}</td>
                  <td className="cell-num">{k.ws_subscribe_rps ?? '—'}</td>
                  <td className="cell-num">{k.ws_unsubscribe_rps ?? '—'}</td>
                  <td className="cell-num">{fmtNum(k.connection_limit)}</td>
                  <td className="cell-muted">{k.provider ?? 'inherit'}</td>
                  <td style={{ minWidth: 90 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span className="cell-num" style={{ minWidth: 32 }}>{fmtNum(httpReq)}</span>
                      <div className={`usage-bar usage-bar--${barVariant}`} style={{ flex: 1 }}>
                        <div className="usage-bar__fill" style={{ width: `${usagePct}%` }} />
                      </div>
                      {wsConns !== null && (
                        <span className="cell-muted" style={{ marginLeft: 2 }}>{wsConns}ws</span>
                      )}
                    </div>
                  </td>
                  <td className="cell-muted">{createdDate}</td>
                  <td>
                    <span style={{ display: 'flex', gap: 3 }}>
                      <button
                        type="button"
                        className="btn-xs"
                        onClick={() => setDetailKey(detailKey === k.key ? '' : k.key)}
                      >
                        {detailKey === k.key ? '▲' : 'Detail'}
                      </button>
                      <button
                        type="button"
                        className="btn-xs"
                        onClick={() => { setLimitKey(k.key); }}
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

      {/* ── Key detail drawer ────────────────────────────────── */}
      {detailKey && (
        <div style={{ background: 'var(--panel-bg)', border: '1px solid var(--panel-border)', borderRadius: 6, padding: '8px 10px', maxHeight: 220, overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>
              KEY DETAIL: {detailKey}
            </span>
            <button type="button" className="btn-xs" onClick={() => setDetailKey('')}>✕</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <div>
              <div className="panel-section-title">LIMITS</div>
              <ErrorInline message={limitsDetail.isError ? (limitsDetail.error as Error).message : null} />
              {limitsDetail.data && <KeyValueGrid rows={limitsToRows(limitsDetail.data).map((r) => ({ label: r.label, value: r.value }))} />}
            </div>
            <div>
              <div className="panel-section-title">USAGE BUNDLE</div>
              <ErrorInline message={usageDetail.isError ? (usageDetail.error as Error).message : null} />
              {usageDetail.data && <KeyValueGrid rows={usageBundleToRows(usageDetail.data).map((r) => ({ label: r.label, value: r.value }))} />}
            </div>
            <div>
              <div className="panel-section-title">LEGACY REPORT</div>
              <ErrorInline message={usageReportQ.isError ? (usageReportQ.error as Error).message : null} />
              {usageReportQ.data && <KeyValueGrid rows={flattenObject(usageReportQ.data, '', 3).map((r) => ({ label: r.label, value: r.value }))} />}
            </div>
          </div>
          {(limitsDetail.data || usageDetail.data) && (
            <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
              {limitsDetail.data && <RawJsonDetails value={limitsDetail.data} summary="Raw limits" />}
              {usageDetail.data && <RawJsonDetails value={usageDetail.data} summary="Raw usage" />}
            </div>
          )}
        </div>
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
          <button type="button" className="btn-xs" disabled={create.isPending || !nk.key} onClick={() => create.mutate(nk)}>
            {create.isPending ? 'Creating…' : '+ Create key'}
          </button>
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
                <option value="kite">kite (Falcon)</option>
                <option value="vortex">vortex (Vayu)</option>
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
