/**
 * @file AuditDebugPage.tsx
 * @module admin-dashboard
 * @description Audit sampling config + Falcon/Vayu provider debug — 3-panel dense layout.
 * @author BharatERP
 * @updated 2026-04-14
 */

import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import { ErrorInline } from '../components/ErrorInline';
import { auditConfigToRows } from '../lib/views/audit-views';
import { flattenObject } from '../lib/views/flatten';
import { useRefreshInterval } from '../hooks/useRefreshInterval';

function StatRow({ label, value, variant }: { label: string; value: React.ReactNode; variant?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="stat-row">
      <span className="stat-row__label">{label}</span>
      <span className={`stat-row__value${variant ? ` stat-row__value--${variant}` : ''}`}>{value}</span>
    </div>
  );
}

function RawCollapsible({ data }: { data: unknown }) {
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ fontSize: 10, color: 'var(--muted)', cursor: 'pointer', userSelect: 'none' }}>
        Raw JSON
      </summary>
      <pre style={{
        fontSize: 9,
        marginTop: 4,
        color: 'var(--muted)',
        maxHeight: 220,
        overflow: 'auto',
        wordBreak: 'break-all',
        lineHeight: 1.4,
        background: 'rgba(0,0,0,0.2)',
        borderRadius: 4,
        padding: '6px 8px',
      }}>
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

export function AuditDebugPage() {
  const token = getAdminToken();
  const { refetchInterval, recordFetchLatency } = useRefreshInterval();

  const falconFn = useCallback(async () => {
    const t0 = performance.now();
    try { return await admin.getKiteDebug(); }
    finally { recordFetchLatency(Math.round(performance.now() - t0)); }
  }, [recordFetchLatency]);

  const vayuFn = useCallback(async () => {
    const t0 = performance.now();
    try { return await admin.getVortexDebug(); }
    finally { recordFetchLatency(Math.round(performance.now() - t0)); }
  }, [recordFetchLatency]);

  const audit = useQuery({
    queryKey: ['admin-audit-config'],
    queryFn: admin.getAuditConfig,
    enabled: !!token,
  });
  const falcon = useQuery({
    queryKey: ['admin-debug-falcon'],
    queryFn: falconFn,
    enabled: !!token,
    refetchInterval,
  });
  const vayu = useQuery({
    queryKey: ['admin-debug-vayu'],
    queryFn: vayuFn,
    enabled: !!token,
    refetchInterval,
  });

  if (!token) {
    return <section className="card"><p className="err">Add an admin token in Settings.</p></section>;
  }

  const auditRows = audit.data ? auditConfigToRows(audit.data) : [];
  const falconRows = flattenObject(falcon.data, '', 3);
  const vayuRows = flattenObject(vayu.data, '', 3);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const falconConnected = (falcon.data as any)?.connected === true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vayuConnected = (vayu.data as any)?.connected === true;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div className="page-head">
        <h1>AUDIT &amp; DEBUG</h1>
        <div style={{ display: 'flex', gap: 12 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
            <span className={`dot ${falconConnected ? 'dot--live' : 'dot--off'}`} />
            <span style={{ color: 'var(--muted)' }}>FALCON {falconConnected ? 'CONN' : 'OFF'}</span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
            <span className={`dot ${vayuConnected ? 'dot--live' : 'dot--off'}`} />
            <span style={{ color: 'var(--muted)' }}>VAYU {vayuConnected ? 'CONN' : 'OFF'}</span>
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, flex: 1, minHeight: 0 }}>
        {/* ── Audit config ──────────────────────────────────── */}
        <div className="panel">
          <div className="panel__head">
            <span className="panel__title">AUDIT SAMPLING</span>
          </div>
          <div className="panel__body">
            <ErrorInline message={audit.isError ? (audit.error as Error).message : null} />
            {audit.isLoading && (
              <span style={{ fontSize: 10, color: 'var(--muted)' }}>Loading…</span>
            )}
            {auditRows.map((r) => (
              <StatRow key={r.label} label={r.label} value={String(r.value)} />
            ))}
            {audit.data && <RawCollapsible data={audit.data} />}
          </div>
        </div>

        {/* ── Falcon debug ──────────────────────────────────── */}
        <div className="panel">
          <div className="panel__head">
            <span className="panel__title">FALCON (KITE) DEBUG</span>
            <span
              className="panel__title-val"
              style={{ color: falconConnected ? 'var(--ok)' : 'var(--muted)' }}
            >
              {falcon.isLoading ? '…' : falconConnected ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
          </div>
          <div className="panel__body">
            <ErrorInline message={falcon.isError ? (falcon.error as Error).message : null} />
            {falcon.isLoading && (
              <span style={{ fontSize: 10, color: 'var(--muted)' }}>Loading…</span>
            )}
            {falconRows.map((r) => (
              <StatRow
                key={r.label}
                label={r.label}
                value={String(r.value)}
                variant={
                  r.label === 'connected'
                    ? String(r.value) === 'true' ? 'ok' : 'bad'
                    : r.label === 'degraded'
                    ? String(r.value) === 'true' ? 'bad' : undefined
                    : undefined
                }
              />
            ))}
            {falcon.data && <RawCollapsible data={falcon.data} />}
          </div>
        </div>

        {/* ── Vayu debug ────────────────────────────────────── */}
        <div className="panel">
          <div className="panel__head">
            <span className="panel__title">VAYU (VORTEX) DEBUG</span>
            <span
              className="panel__title-val"
              style={{ color: vayuConnected ? 'var(--ok)' : 'var(--muted)' }}
            >
              {vayu.isLoading ? '…' : vayuConnected ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
          </div>
          <div className="panel__body">
            <ErrorInline message={vayu.isError ? (vayu.error as Error).message : null} />
            {vayu.isLoading && (
              <span style={{ fontSize: 10, color: 'var(--muted)' }}>Loading…</span>
            )}
            {vayuRows.map((r) => (
              <StatRow
                key={r.label}
                label={r.label}
                value={String(r.value)}
                variant={
                  r.label === 'connected'
                    ? String(r.value) === 'true' ? 'ok' : 'bad'
                    : undefined
                }
              />
            ))}
            {vayu.data && <RawCollapsible data={vayu.data} />}
          </div>
        </div>
      </div>
    </div>
  );
}
