/**
 * @file AbusePage.tsx
 * @module admin-dashboard
 * @description Security / abuse dashboard: risk scores, dense table, inline block/unblock controls.
 * @author BharatERP
 * @updated 2026-04-14
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import type { AbuseFlag } from '../lib/types';
import { ErrorInline } from '../components/ErrorInline';
import { abuseRiskVariant } from '../lib/views/abuse-views';
import { useRefreshInterval } from '../hooks/useRefreshInterval';

function fmtDate(d: string | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function truncKey(k: string, len = 22) {
  return k.length > len ? `${k.slice(0, len)}…` : k;
}

export function AbusePage() {
  const token = getAdminToken();
  const qc = useQueryClient();
  const { refetchInterval, recordFetchLatency } = useRefreshInterval();
  const [page, setPage] = useState(1);
  const [blockedFilter, setBlockedFilter] = useState<boolean | undefined>(undefined);
  const [blockKey, setBlockKey] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const [unblockKey, setUnblockKey] = useState('');
  const [lookupKey, setLookupKey] = useState('');

  const fetchFlags = useCallback(async () => {
    const t0 = performance.now();
    try { return await admin.listAbuseFlags(page, 50, blockedFilter); }
    finally { recordFetchLatency(Math.round(performance.now() - t0)); }
  }, [page, blockedFilter, recordFetchLatency]);

  const list = useQuery({
    queryKey: ['admin-abuse', page, blockedFilter],
    queryFn: fetchFlags,
    enabled: !!token,
    refetchInterval,
  });

  const one = useQuery({
    queryKey: ['admin-abuse-one', lookupKey],
    queryFn: () => admin.getAbuseFlag(lookupKey),
    enabled: !!token && lookupKey.length > 2,
  });

  const block = useMutation({
    mutationFn: admin.manualBlockAbuse,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-abuse'] }),
  });
  const unblock = useMutation({
    mutationFn: admin.manualUnblockAbuse,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-abuse'] }),
  });

  if (!token) {
    return (
      <section className="card">
        <p className="err">Add an admin token in Settings.</p>
      </section>
    );
  }

  const flags: AbuseFlag[] = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  const blockedCount = flags.filter((f) => f.blocked).length;
  const highRiskCount = flags.filter((f) => f.risk_score >= 70).length;

  return (
    <div className="abuse-layout" style={{ height: '100%' }}>
      {/* ── Header ──────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, paddingBottom: 8, borderBottom: '1px solid var(--panel-border)', flexShrink: 0 }}>
        <h1 style={{ margin: 0, fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>
          SECURITY / ABUSE MONITOR
        </h1>
        {/* Summary chips */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: 'rgba(255,255,255,0.06)', color: 'var(--muted)', border: '1px solid var(--panel-border)' }}>
            {total} TOTAL
          </span>
          <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: blockedCount > 0 ? 'rgba(255,107,107,0.12)' : 'rgba(255,255,255,0.06)', color: blockedCount > 0 ? 'var(--bad)' : 'var(--muted)', border: `1px solid ${blockedCount > 0 ? 'rgba(255,107,107,0.25)' : 'var(--panel-border)'}` }}>
            {blockedCount} BLOCKED
          </span>
          <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: highRiskCount > 0 ? 'rgba(255,68,68,0.12)' : 'rgba(255,255,255,0.06)', color: highRiskCount > 0 ? 'var(--risk-hi)' : 'var(--muted)', border: `1px solid ${highRiskCount > 0 ? 'rgba(255,68,68,0.25)' : 'var(--panel-border)'}` }}>
            {highRiskCount} HIGH RISK
          </span>
        </div>
      </div>

      {/* ── Toolbar ─────────────────────────────────────────── */}
      <div className="abuse-toolbar">
        <span className="muted" style={{ fontSize: 10, fontWeight: 700, marginRight: 4 }}>FILTER:</span>
        {([
          { label: 'All', val: undefined },
          { label: 'Blocked only', val: true },
          { label: 'Not blocked', val: false },
        ] as Array<{ label: string; val: boolean | undefined }>).map(({ label, val }) => (
          <button
            key={label}
            type="button"
            className={`btn-xs ${blockedFilter === val ? 'btn-xs--ok' : ''}`}
            onClick={() => { setBlockedFilter(val); setPage(1); }}
          >
            {label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" className="btn-xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</button>
          <span className="muted" style={{ fontSize: 10 }}>{page} / {totalPages}</span>
          <button type="button" className="btn-xs" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next →</button>
        </span>
      </div>

      {/* ── Flags table ─────────────────────────────────────── */}
      <div className="abuse-main">
        <ErrorInline message={list.isError ? (list.error as Error).message : null} />
        <table className="data-table">
          <thead>
            <tr>
              <th>API KEY</th>
              <th>TENANT</th>
              <th style={{ width: 90 }}>RISK SCORE</th>
              <th style={{ width: 44 }}>BLK</th>
              <th>REASON CODES</th>
              <th>DETECTED</th>
              <th>LAST SEEN</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {flags.map((f: AbuseFlag) => {
              const riskClass = f.risk_score >= 70 ? 'hi' : f.risk_score >= 30 ? 'med' : 'lo';
              const riskVariant = abuseRiskVariant(f.risk_score);
              void riskVariant; /* used by original view — kept for compat */

              return (
                <tr key={f.api_key}>
                  <td>
                    <span className="cell-key" title={f.api_key}>{truncKey(f.api_key)}</span>
                  </td>
                  <td className="cell-muted">{f.tenant_id ?? '—'}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          minWidth: 24,
                          color: f.risk_score >= 70 ? 'var(--risk-hi)' : f.risk_score >= 30 ? 'var(--risk-med)' : 'var(--risk-lo)',
                          fontFamily: 'ui-monospace, monospace',
                        }}
                      >
                        {f.risk_score}
                      </span>
                      <div className={`risk-bar risk-bar--${riskClass}`} style={{ flex: 1 }}>
                        <div className="risk-bar__fill" style={{ width: `${f.risk_score}%` }} />
                      </div>
                    </div>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <span className={`dot ${f.blocked ? 'dot--dead' : 'dot--live'}`} />
                  </td>
                  <td style={{ maxWidth: 200 }}>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                      {(f.reason_codes ?? []).map((rc) => (
                        <span key={rc} className="reason-pill">{rc}</span>
                      ))}
                      {(f.reason_codes ?? []).length === 0 && <span className="cell-muted">—</span>}
                    </span>
                  </td>
                  <td className="cell-muted">{fmtDate(f.detected_at)}</td>
                  <td className="cell-muted">{fmtDate(f.last_seen_at)}</td>
                  <td>
                    <span style={{ display: 'flex', gap: 3 }}>
                      {!f.blocked ? (
                        <button
                          type="button"
                          className="btn-xs btn-xs--danger"
                          onClick={() => block.mutate({ api_key: f.api_key, reason: 'manual-admin' })}
                          disabled={block.isPending}
                          title="Block this key"
                        >
                          BLOCK
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-xs btn-xs--ok"
                          onClick={() => unblock.mutate({ api_key: f.api_key })}
                          disabled={unblock.isPending}
                          title="Unblock this key"
                        >
                          UNBLK
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
            {flags.length === 0 && (
              <tr>
                <td colSpan={8} className="cell-muted" style={{ textAlign: 'center', padding: '16px 8px' }}>
                  {list.isLoading ? 'Loading…' : 'No abuse flags found'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Action forms ────────────────────────────────────── */}
      <div className="abuse-forms">
        <div className="abuse-form-card">
          <div className="abuse-form-card__title">MANUAL BLOCK</div>
          <div className="abuse-form-row" style={{ marginBottom: 6 }}>
            <div>
              <label style={{ fontSize: 10 }}>API Key</label>
              <input value={blockKey} onChange={(e) => setBlockKey(e.target.value)} placeholder="api-key-id" style={{ fontSize: 11, padding: '4px 6px' }} />
            </div>
            <div>
              <label style={{ fontSize: 10 }}>Reason (optional)</label>
              <input value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="resell/abuse" style={{ fontSize: 11, padding: '4px 6px' }} />
            </div>
          </div>
          <button
            type="button"
            className="btn-xs btn-xs--danger"
            disabled={!blockKey || block.isPending}
            onClick={() => block.mutate({ api_key: blockKey, reason: blockReason || undefined })}
          >
            {block.isPending ? 'Blocking…' : 'Block key'}
          </button>
          {block.isError && <p className="err" style={{ fontSize: 10, marginTop: 4 }}>{(block.error as Error).message}</p>}
        </div>

        <div className="abuse-form-card">
          <div className="abuse-form-card__title">MANUAL UNBLOCK + LOOKUP</div>
          <div className="abuse-form-row" style={{ marginBottom: 6 }}>
            <div>
              <label style={{ fontSize: 10 }}>Unblock Key</label>
              <input value={unblockKey} onChange={(e) => setUnblockKey(e.target.value)} placeholder="api-key-id" style={{ fontSize: 11, padding: '4px 6px' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button
                type="button"
                className="btn-xs btn-xs--ok"
                disabled={!unblockKey || unblock.isPending}
                onClick={() => unblock.mutate({ api_key: unblockKey })}
              >
                {unblock.isPending ? 'Unblocking…' : 'Unblock key'}
              </button>
            </div>
          </div>
          <div className="abuse-form-row">
            <div>
              <label style={{ fontSize: 10 }}>Lookup single key</label>
              <input value={lookupKey} onChange={(e) => setLookupKey(e.target.value)} placeholder="api-key-id" style={{ fontSize: 11, padding: '4px 6px' }} />
            </div>
          </div>
          {one.data && (
            <div style={{ marginTop: 6, fontSize: 10, background: 'rgba(0,0,0,0.2)', borderRadius: 4, padding: '6px 8px' }}>
              <pre style={{ margin: 0, fontSize: 9, overflow: 'auto', maxHeight: 80, color: 'var(--text)' }}>
                {JSON.stringify(one.data, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
