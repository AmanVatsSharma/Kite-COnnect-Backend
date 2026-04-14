/**
 * @file WsAdminPage.tsx
 * @module admin-dashboard
 * @description WebSocket admin: live connections monitor, status/config, forms.
 * @updated 2026-04-14
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import { ErrorInline } from '../components/ErrorInline';
import { wsStatusSummaryRows } from '../lib/views/overview-views';
import { wsConfigToRows } from '../lib/views/ws-config-views';
import { flattenObject } from '../lib/views/flatten';

export function WsAdminPage() {
  const token = getAdminToken();
  const qc = useQueryClient();
  /** `null` = show server baseline; string = user override (incl. empty). */
  const [subRps, setSubRps] = useState<string | null>(null);
  const [unsubRps, setUnsubRps] = useState<string | null>(null);
  const [modeRps, setModeRps] = useState<string | null>(null);
  const [entKey, setEntKey] = useState('');
  const [entEx, setEntEx] = useState('NSE_EQ,NSE_FO');
  const [blJson, setBlJson] = useState('{}');
  const [flushCaches, setFlushCaches] = useState('ws_counters');
  const [bcEvent, setBcEvent] = useState('ping');
  const [bcRoom, setBcRoom] = useState('');
  const [bcPayload, setBcPayload] = useState('{"hello":true}');

  const status = useQuery({
    queryKey: ['admin-ws-status'],
    queryFn: admin.getWsStatus,
    enabled: !!token,
  });

  const config = useQuery({
    queryKey: ['admin-ws-config'],
    queryFn: admin.getWsConfig,
    enabled: !!token,
  });

  const rateBaseline = useMemo(() => {
    const c = config.data;
    if (!c || typeof c !== 'object') return { sub: '', unsub: '', mode: '' };
    const o = c as unknown as Record<string, unknown>;
    const rl = o.rate_limits;
    if (!rl || typeof rl !== 'object') return { sub: '', unsub: '', mode: '' };
    const r = rl as Record<string, unknown>;
    return {
      sub: typeof r.subscribe_rps === 'number' ? String(r.subscribe_rps) : '',
      unsub: typeof r.unsubscribe_rps === 'number' ? String(r.unsubscribe_rps) : '',
      mode: typeof r.mode_rps === 'number' ? String(r.mode_rps) : '',
    };
  }, [config.data]);

  const subRpsVal = subRps ?? rateBaseline.sub;
  const unsubRpsVal = unsubRps ?? rateBaseline.unsub;
  const modeRpsVal = modeRps ?? rateBaseline.mode;

  const setRps = useMutation({
    mutationFn: admin.setWsRateLimits,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-ws-config'] });
      setSubRps(null);
      setUnsubRps(null);
      setModeRps(null);
    },
  });

  const ent = useMutation({ mutationFn: admin.setWsEntitlements });
  const block = useMutation({ mutationFn: admin.addWsBlocklist });
  const flush = useMutation({ mutationFn: admin.flushWsCaches });
  const broadcast = useMutation({ mutationFn: admin.wsBroadcast });

  if (!token) {
    return (
      <section className="card">
        <p className="err">Add an admin token in Settings.</p>
      </section>
    );
  }

  const statusRows = status.data ? wsStatusSummaryRows(status.data) : [];
  const statusExtra =
    status.data && !statusRows.length ? flattenObject(status.data, '', 2) : statusRows;
  const conn =
    status.data && typeof status.data === 'object'
      ? (status.data as Record<string, unknown>).connections
      : undefined;

  /* Per-key subscription breakdown */
  const subscriptions: Array<Record<string, unknown>> =
    status.data && Array.isArray((status.data as Record<string, unknown>).subscriptions)
      ? ((status.data as Record<string, unknown>).subscriptions as Array<Record<string, unknown>>)
      : [];
  const byApiKey: Array<Record<string, unknown>> =
    status.data && Array.isArray((status.data as Record<string, unknown>).byApiKey)
      ? ((status.data as Record<string, unknown>).byApiKey as Array<Record<string, unknown>>)
      : [];

  function fmtNum(n: unknown): string {
    if (typeof n !== 'number') return '—';
    return n.toLocaleString('en-IN');
  }
  function truncKey(k: string, len = 20) {
    return k.length > len ? `${k.slice(0, len)}…` : k;
  }

  return (
    <>
      {/* ── Live Connections Panel ─────────────────────────── */}
      <div className="ws-conn-panel">
        <div className="ws-conn-panel__head">
          <span>LIVE WS CONNECTIONS</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {typeof conn === 'number' && conn > 0 && (
              <span className="dot dot--live" style={{ marginRight: 2 }} />
            )}
            <span className="ws-conn-panel__total">{typeof conn === 'number' ? conn : '—'} conn</span>
            <span className="cell-muted" style={{ fontSize: 10 }}>
              {subscriptions.length} sub groups
            </span>
            {typeof (status.data as Record<string, unknown> | undefined)?.redis_ok === 'boolean' && (
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                color: (status.data as Record<string, unknown>).redis_ok ? 'var(--ok)' : 'var(--bad)',
              }}>
                REDIS {(status.data as Record<string, unknown>).redis_ok ? 'OK' : 'ISSUE'}
              </span>
            )}
          </div>
        </div>
        <ErrorInline message={status.isError ? (status.error as Error).message : null} />
        {byApiKey.length > 0 ? (
          <div className="ws-conn-panel__body">
            <table className="data-table">
              <thead>
                <tr>
                  <th>API KEY</th>
                  <th className="cell-num">CONNS</th>
                  <th className="cell-num">TOKENS</th>
                  <th>MODE</th>
                  <th>EXCHANGES</th>
                </tr>
              </thead>
              <tbody>
                {byApiKey.map((row, i) => {
                  const keyStr = String(row.apiKey ?? '');
                  const subEntry = subscriptions.find((s) => s.apiKey === row.apiKey);
                  const tokens: unknown[] = Array.isArray(subEntry?.tokens) ? (subEntry!.tokens as unknown[]) : [];
                  const mode = typeof subEntry?.mode === 'string' ? subEntry.mode : '—';
                  return (
                    <tr key={i}>
                      <td className="cell-key" title={keyStr}>{truncKey(keyStr)}</td>
                      <td className="cell-num">{fmtNum(row.count)}</td>
                      <td className="cell-num">{fmtNum(tokens.length)}</td>
                      <td style={{ fontSize: 10 }}>
                        <span style={{
                          padding: '1px 5px',
                          borderRadius: 3,
                          background: mode === 'full' ? 'rgba(124,158,255,0.15)' : mode === 'ohlcv' ? 'rgba(255,182,72,0.12)' : 'rgba(43,211,155,0.1)',
                          color: mode === 'full' ? 'var(--accent)' : mode === 'ohlcv' ? 'var(--warn)' : 'var(--ok)',
                          fontSize: 9,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                        }}>
                          {mode}
                        </span>
                      </td>
                      <td className="cell-muted" style={{ fontSize: 10 }}>
                        {tokens.length > 0
                          ? `${String(tokens[0])}${tokens.length > 1 ? ` +${tokens.length - 1}` : ''}`
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : subscriptions.length > 0 ? (
          <div className="ws-conn-panel__body">
            <table className="data-table">
              <thead>
                <tr>
                  <th>API KEY</th>
                  <th className="cell-num">TOKENS</th>
                  <th>MODE</th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.slice(0, 20).map((s, i) => {
                  const tokens: unknown[] = Array.isArray(s.tokens) ? (s.tokens as unknown[]) : [];
                  return (
                    <tr key={i}>
                      <td className="cell-key" title={String(s.apiKey ?? '')}>{truncKey(String(s.apiKey ?? ''))}</td>
                      <td className="cell-num">{fmtNum(tokens.length)}</td>
                      <td style={{ fontSize: 9, textTransform: 'uppercase', color: 'var(--muted)' }}>{String(s.mode ?? '—')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="ws-conn-panel__empty">
            {status.isLoading ? 'Loading…' : typeof conn === 'number' && conn === 0 ? 'No active connections' : 'No subscription data'}
          </div>
        )}
      </div>

      {/* ── Config + Actions grid ─────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {/* WS status + config */}
        <div className="panel">
          <div className="panel__head">
            <span className="panel__title">WS STATUS &amp; CONFIG</span>
          </div>
          <div className="panel__body">
            <ErrorInline message={status.isError ? (status.error as Error).message : null} />
            {statusExtra.map((r) => (
              <div key={r.label} className="stat-row">
                <span className="stat-row__label">{r.label}</span>
                <span className="stat-row__value">{String(r.value)}</span>
              </div>
            ))}
            <ErrorInline message={config.isError ? (config.error as Error).message : null} />
            {config.data && (
              <>
                <div className="panel-section-title" style={{ marginTop: 6 }}>RATE LIMITS (env)</div>
                {wsConfigToRows(config.data).map((r) => (
                  <div key={r.label} className="stat-row">
                    <span className="stat-row__label">{r.label}</span>
                    <span className="stat-row__value">{String(r.value)}</span>
                  </div>
                ))}
              </>
            )}
            <div className="panel-section-title" style={{ marginTop: 6 }}>UPDATE RATE LIMITS</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 4 }}>
              {[['Sub RPS', subRpsVal, setSubRps], ['Unsub RPS', unsubRpsVal, setUnsubRps], ['Mode RPS', modeRpsVal, setModeRps]] as const}
              {([['Sub RPS', subRpsVal, (v: string) => setSubRps(v)], ['Unsub RPS', unsubRpsVal, (v: string) => setUnsubRps(v)], ['Mode RPS', modeRpsVal, (v: string) => setModeRps(v)]] as Array<[string, string, (v: string) => void]>).map(([lbl, val, set]) => (
                <div key={lbl}>
                  <label style={{ fontSize: 10, marginBottom: 2 }}>{lbl}</label>
                  <input value={val} onChange={(e) => set(e.target.value)} style={{ fontSize: 11, padding: '4px 6px' }} />
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn-xs"
              style={{ marginTop: 6 }}
              disabled={setRps.isPending}
              onClick={() => setRps.mutate({
                subscribe_rps: subRpsVal.trim() !== '' ? Number(subRpsVal) : undefined,
                unsubscribe_rps: unsubRpsVal.trim() !== '' ? Number(unsubRpsVal) : undefined,
                mode_rps: modeRpsVal.trim() !== '' ? Number(modeRpsVal) : undefined,
              })}
            >
              {setRps.isPending ? 'Saving…' : 'Apply rate limits'}
            </button>
          </div>
        </div>

        {/* Right column: Entitlements + Blocklist + Flush */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Entitlements */}
          <div className="panel">
            <div className="panel__head"><span className="panel__title">EXCHANGE ENTITLEMENTS</span></div>
            <div className="panel__body">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
                <div>
                  <label style={{ fontSize: 10, marginBottom: 2 }}>API Key</label>
                  <input value={entKey} onChange={(e) => setEntKey(e.target.value)} style={{ fontSize: 11, padding: '4px 6px' }} />
                </div>
                <div>
                  <label style={{ fontSize: 10, marginBottom: 2 }}>Exchanges (comma)</label>
                  <input value={entEx} onChange={(e) => setEntEx(e.target.value)} style={{ fontSize: 11, padding: '4px 6px' }} />
                </div>
              </div>
              <button type="button" className="btn-xs" disabled={ent.isPending || !entKey}
                onClick={() => ent.mutate({ apiKey: entKey, exchanges: entEx.split(',').map((s) => s.trim()).filter(Boolean) })}>
                {ent.isPending ? 'Saving…' : 'Save entitlements'}
              </button>
            </div>
          </div>

          {/* Blocklist + Flush side-by-side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="panel">
              <div className="panel__head"><span className="panel__title">BLOCKLIST (JSON)</span></div>
              <div className="panel__body">
                <p style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 4 }}>tokens[], exchanges[], apiKey, tenant_id, reason</p>
                <textarea value={blJson} onChange={(e) => setBlJson(e.target.value)} style={{ minHeight: 60, fontSize: 10, padding: '4px 6px', width: '100%' }} />
                <button type="button" className="btn-xs" style={{ marginTop: 4 }} disabled={block.isPending}
                  onClick={() => { try { block.mutate(JSON.parse(blJson)); } catch { alert('Invalid JSON'); } }}>
                  {block.isPending ? '…' : 'Add entries'}
                </button>
              </div>
            </div>
            <div className="panel">
              <div className="panel__head"><span className="panel__title">FLUSH CACHES</span></div>
              <div className="panel__body">
                <p style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 4 }}>Comma: last_tick, exchange_map, ws_counters</p>
                <input value={flushCaches} onChange={(e) => setFlushCaches(e.target.value)} style={{ fontSize: 11, padding: '4px 6px', marginBottom: 6, width: '100%' }} />
                <button type="button" className="btn-xs btn-xs--danger" disabled={flush.isPending}
                  onClick={() => flush.mutate(flushCaches.split(',').map((s) => s.trim()).filter(Boolean))}>
                  {flush.isPending ? 'Flushing…' : '⚡ Flush'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Namespace broadcast ───────────────────────────── */}
      <div className="panel" style={{ flexShrink: 0 }}>
        <div className="panel__head"><span className="panel__title">NAMESPACE BROADCAST</span></div>
        <div className="panel__body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 8, marginBottom: 6 }}>
            <div>
              <label style={{ fontSize: 10, marginBottom: 2 }}>Event</label>
              <input value={bcEvent} onChange={(e) => setBcEvent(e.target.value)} style={{ fontSize: 11, padding: '4px 6px' }} />
            </div>
            <div>
              <label style={{ fontSize: 10, marginBottom: 2 }}>Room (optional)</label>
              <input value={bcRoom} onChange={(e) => setBcRoom(e.target.value)} style={{ fontSize: 11, padding: '4px 6px' }} />
            </div>
            <div>
              <label style={{ fontSize: 10, marginBottom: 2 }}>Payload (JSON)</label>
              <input value={bcPayload} onChange={(e) => setBcPayload(e.target.value)} style={{ fontSize: 11, padding: '4px 6px', fontFamily: 'monospace' }} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="btn-xs" disabled={broadcast.isPending}
              onClick={() => { try { broadcast.mutate({ event: bcEvent, room: bcRoom || undefined, payload: JSON.parse(bcPayload) as object }); } catch { alert('Invalid JSON'); } }}>
              {broadcast.isPending ? 'Sending…' : '📡 Broadcast'}
            </button>
            {broadcast.data && (
              <span style={{ fontSize: 10, color: 'var(--ok)' }}>
                {(broadcast.data as Record<string, unknown>).success ? 'Sent ✓' : JSON.stringify(broadcast.data)}
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
