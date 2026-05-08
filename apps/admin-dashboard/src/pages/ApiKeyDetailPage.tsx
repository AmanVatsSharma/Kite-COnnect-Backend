/**
 * @file ApiKeyDetailPage.tsx
 * @module admin-dashboard
 * @description The ultimate detail page for an API Key, showing every possible metric and control.
 */

import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import { ErrorInline } from '../components/ErrorInline';
import { KeyValueGrid } from '../components/KeyValueGrid';
import { limitsToRows, usageBundleToRows } from '../lib/views/api-key-views';

function fmtNum(n: unknown): string {
  if (typeof n !== 'number') return '—';
  return n.toLocaleString('en-IN');
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

export function ApiKeyDetailPage() {
  const { key } = useParams<{ key: string }>();
  const token = getAdminToken();
  const qc = useQueryClient();

  const [limitBody, setLimitBody] = useState('{\n  "rate_limit_per_minute": 600,\n  "connection_limit": 2000,\n  "ws_subscribe_rps": 10,\n  "ws_unsubscribe_rps": 10,\n  "ws_mode_rps": 20,\n  "ws_max_instruments": 3000\n}');
  const [prov, setProv] = useState<'kite' | 'vortex' | 'massive' | 'binance' | 'inherit'>('inherit');

  // Queries
  const limits = useQuery({
    queryKey: ['admin-key-limits', key],
    queryFn: () => admin.getApiKeyLimits(key!),
    enabled: !!token && !!key,
  });

  const usage = useQuery({
    queryKey: ['admin-key-usage', key],
    queryFn: () => admin.getApiKeyUsage(key!),
    enabled: !!token && !!key,
    refetchInterval: 5000,
  });

  const live = useQuery({
    queryKey: ['admin-key-live', key],
    queryFn: () => admin.getApiKeyLiveDetail(key!),
    enabled: !!token && !!key,
    refetchInterval: 3000,
  });

  const abuse = useQuery({
    queryKey: ['admin-key-abuse', key],
    queryFn: () => admin.getAbuseFlag(key!),
    enabled: !!token && !!key,
  });

  // Mutations
  const patchLimits = useMutation({
    mutationFn: (b: Parameters<typeof admin.updateApiKeyLimits>[0]) => admin.updateApiKeyLimits(b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-key-limits', key] });
      void qc.invalidateQueries({ queryKey: ['admin-key-usage', key] });
      alert('Limits updated successfully');
    }
  });

  const setProvider = useMutation({
    mutationFn: admin.setApiKeyProvider,
    onSuccess: () => {
      alert('Provider override saved');
    }
  });

  const deactivate = useMutation({
    mutationFn: admin.deactivateApiKey,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-key-limits', key] })
  });

  const blockKey = useMutation({
    mutationFn: admin.manualBlockAbuse,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-key-abuse', key] })
  });

  const unblockKey = useMutation({
    mutationFn: admin.manualUnblockAbuse,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-key-abuse', key] })
  });

  const disconnect = useMutation({
    mutationFn: admin.disconnectSocket,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-key-live', key] })
  });

  if (!token) return <div className="card"><p className="err">No admin token</p></div>;
  if (!key) return <div className="card"><p className="err">No key specified</p></div>;

  function submitLimits() {
    let extra: Record<string, unknown>;
    try { extra = JSON.parse(limitBody); } catch { alert('Limits JSON invalid'); return; }
    patchLimits.mutate({ key: key!, ...extra } as Parameters<typeof admin.updateApiKeyLimits>[0]);
  }

  const limitsData = limits.data as Record<string, unknown> | undefined;
  const usageData = usage.data as Record<string, unknown> | undefined;
  const isActive = limitsData?.is_active === true;
  const tenantId = limitsData?.tenant_id as string | undefined;

  const abuseData = abuse.data as Record<string, unknown> | undefined;
  const isBlocked = (abuseData?.flag as any)?.blocked === true;
  const riskScore = (abuseData?.flag as any)?.risk_score || 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <Link to="/keys" style={{ fontSize: 12, color: 'var(--muted)', textDecoration: 'none', marginBottom: 4, display: 'inline-block' }}>← Back to Keys</Link>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            API KEY: {key}
            <span className={`dot ${isActive ? 'dot--live' : 'dot--off'}`} title={isActive ? 'Active' : 'Inactive'} />
            {isBlocked && <span style={{ fontSize: 10, background: 'var(--bad)', color: '#fff', padding: '2px 6px', borderRadius: 4, verticalAlign: 'middle' }}>BLOCKED</span>}
          </h1>
          <div className="muted" style={{ fontSize: 12 }}>Tenant: {tenantId || '—'}</div>
        </div>
        <div className="page-head-actions" style={{ display: 'flex', gap: 8 }}>
          <button className="btn-xs" onClick={() => void qc.invalidateQueries({ queryKey: ['admin-key-limits', key] })}>Refresh</button>
          {isActive ? (
            <button className="btn-xs btn-xs--danger" onClick={() => { if(confirm('Deactivate this key?')) deactivate.mutate(key) }} disabled={deactivate.isPending}>
              Deactivate Key
            </button>
          ) : (
            <span className="muted" style={{ fontSize: 12, display: 'flex', alignItems: 'center' }}>Inactive</span>
          )}
        </div>
      </div>

      {/* Metrics Summary Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
        {[
          { label: 'LIVE CONNS', value: fmtNum(live.data?.liveConnections) },
          { label: 'LIVE SUBS', value: fmtNum(live.data?.liveSubscriptions) },
          { label: 'BYTES / 24H', value: formatBytes(live.data?.bytesLast24h || 0) },
          { label: 'HTTP / MIN', value: fmtNum(live.data?.httpRequestsThisMinute) },
          { label: 'RISK SCORE', value: riskScore, color: riskScore > 50 ? 'var(--warn-fg)' : 'inherit' },
        ].map((item) => (
          <div key={item.label} className="card" style={{ padding: 12, textAlign: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 }}>{item.label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: item.color || 'var(--fg)' }}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* Top and Bottom Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        
        {/* Left Column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Limits & Usage */}
          <div className="panel">
            <div className="panel__head"><span className="panel__title">LIMITS & USAGE</span></div>
            <div className="panel__body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>CONFIGURED LIMITS</div>
                <ErrorInline message={limits.isError ? (limits.error as Error).message : null} />
                {limitsData && <KeyValueGrid rows={limitsToRows(limitsData).map((r) => ({ label: r.label, value: r.value }))} />}
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>CURRENT USAGE</div>
                <ErrorInline message={usage.isError ? (usage.error as Error).message : null} />
                {usageData && <KeyValueGrid rows={usageBundleToRows(usageData).map((r) => ({ label: r.label, value: r.value }))} />}
              </div>
            </div>
          </div>

          {/* Update Limits Form */}
          <div className="panel">
            <div className="panel__head"><span className="panel__title">UPDATE LIMITS (JSON)</span></div>
            <div className="panel__body">
              <p style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 6 }}>Fields: rate_limit_per_minute, connection_limit, ws_subscribe_rps, ws_unsubscribe_rps, ws_mode_rps, ws_max_instruments, allowed_exchanges[]</p>
              <textarea value={limitBody} onChange={(e) => setLimitBody(e.target.value)} style={{ width: '100%', height: 120, fontFamily: 'monospace', fontSize: 12, padding: 8, background: 'rgba(0,0,0,0.1)', border: '1px solid var(--panel-border)', color: 'var(--fg)' }} />
              <button className="btn-xs" style={{ marginTop: 8 }} disabled={patchLimits.isPending} onClick={submitLimits}>
                {patchLimits.isPending ? 'Saving...' : 'Apply Limits'}
              </button>
            </div>
          </div>

          {/* Security & Controls */}
          <div className="panel">
            <div className="panel__head"><span className="panel__title">SECURITY & ABUSE CONTROL</span></div>
            <div className="panel__body">
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, marginBottom: 4 }}>
                    <strong>Risk Score:</strong> {riskScore}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    <strong>Reasons:</strong> {((abuseData?.flag as any)?.reason_codes || []).join(', ') || 'None'}
                  </div>
                </div>
                <div>
                  {isBlocked ? (
                    <button className="btn-xs" style={{ background: 'var(--ok)', color: '#fff' }} onClick={() => unblockKey.mutate({ api_key: key })} disabled={unblockKey.isPending}>
                      UNBLOCK KEY
                    </button>
                  ) : (
                    <button className="btn-xs btn-xs--danger" onClick={() => { if(confirm('Block this key?')) blockKey.mutate({ api_key: key, reason: 'Manual block from ultimate page' }) }} disabled={blockKey.isPending}>
                      BLOCK KEY
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Provider Override */}
          <div className="panel">
            <div className="panel__head"><span className="panel__title">PROVIDER OVERRIDE</span></div>
            <div className="panel__body">
              <p style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 6 }}>Pin this key to a specific market data provider (e.g. forced Kite or Vortex).</p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select value={prov} onChange={(e) => setProv(e.target.value as typeof prov)} style={{ flex: 1, padding: '4px 8px', background: 'var(--panel-bg)', color: 'var(--fg)', border: '1px solid var(--panel-border)' }}>
                  <option value="inherit">Inherit Global</option>
                  <option value="kite">Falcon</option>
                  <option value="vortex">Vayu</option>
                  <option value="massive">Atlas</option>
                  <option value="binance">Drift</option>
                </select>
                <button className="btn-xs" disabled={setProvider.isPending} onClick={() => setProvider.mutate({ key, provider: prov === 'inherit' ? null : prov })}>
                  {setProvider.isPending ? 'Saving...' : 'Set Provider'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Live Sockets */}
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="panel__head"><span className="panel__title">LIVE SOCKET SESSIONS</span></div>
            <div className="panel__body" style={{ padding: 0, overflowY: 'auto', flex: 1 }}>
              <ErrorInline message={live.isError ? (live.error as Error).message : null} />
              <table className="data-table">
                <thead>
                  <tr>
                    <th>SOCKET ID</th>
                    <th>IP / ORIGIN</th>
                    <th className="cell-num">INSTR</th>
                    <th>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {live.data?.sockets.map((s) => (
                    <tr key={s.socketId}>
                      <td className="cell-key" title={s.socketId}>{s.socketId.slice(0, 10)}…</td>
                      <td>
                        <div style={{ fontSize: 11 }}>{s.ip || '—'}</div>
                        <div className="cell-muted" style={{ fontSize: 9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>{s.origin || '—'}</div>
                      </td>
                      <td className="cell-num" style={{ fontWeight: 700 }}>{s.instruments}</td>
                      <td>
                        <button className="btn-xs btn-xs--danger" onClick={() => { if(confirm('Kill socket?')) disconnect.mutate(s.socketId) }} disabled={disconnect.isPending}>
                          KILL
                        </button>
                      </td>
                    </tr>
                  ))}
                  {(!live.data?.sockets || live.data.sockets.length === 0) && (
                    <tr><td colSpan={4} style={{ textAlign: 'center', padding: 20 }} className="cell-muted">No live sessions</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Top Domains / Origins (24H) */}
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="panel__head"><span className="panel__title">TOP DOMAINS / HOSTS (LAST 24H)</span></div>
            <div className="panel__body" style={{ padding: 0, overflowY: 'auto', flex: 1 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>ORIGIN / DOMAIN</th>
                    <th>KIND</th>
                    <th className="cell-num">HITS</th>
                    <th>LAST SEEN</th>
                  </tr>
                </thead>
                <tbody>
                  {live.data?.topOrigins.map((o, i) => (
                    <tr key={i}>
                      <td title={o.origin || 'null'} style={{ fontSize: 11 }}>{o.origin || <span className="cell-muted">null/direct</span>}</td>
                      <td><span style={{ fontSize: 9, textTransform: 'uppercase', color: o.kind === 'ws' ? 'var(--ok)' : 'var(--warn)' }}>{o.kind}</span></td>
                      <td className="cell-num">{fmtNum(o.hitCount)}</td>
                      <td className="cell-muted" style={{ fontSize: 10 }}>{relativeTime(o.lastSeen)}</td>
                    </tr>
                  ))}
                  {(!live.data?.topOrigins || live.data.topOrigins.length === 0) && (
                    <tr><td colSpan={4} style={{ textAlign: 'center', padding: 20 }} className="cell-muted">No origin data</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
