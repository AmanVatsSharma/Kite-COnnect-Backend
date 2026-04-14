/**
 * @file OverviewPage.tsx
 * @module admin-dashboard
 * @description Command center: high-density multi-panel operations view for trading broker/dealer.
 * @author BharatERP
 * @created 2026-03-28
 * @updated 2026-04-14 — Phase 3: added recent stream events feed
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import type { AdminStreamEvent } from '../lib/admin-api';
import { useLiveAdminMetrics } from '../hooks/useLiveAdminMetrics';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
import * as admin from '../lib/admin-api';
import type { ApiKeyRow, ApiKeyUsageItem } from '../lib/types';
import { healthServiceRows, healthOverallStatus, marketDataSummaryRows, stockStatsMetricCards } from '../lib/views/overview-views';

/* ─── helpers ────────────────────────────────────────────────────────── */
function fmtNum(n: unknown): string {
  if (typeof n !== 'number') return '—';
  return n.toLocaleString('en-IN');
}

function fmtBytes(n: unknown): string {
  if (typeof n !== 'number') return '—';
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)}GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)}MB`;
  if (n >= 1_024) return `${(n / 1_024).toFixed(1)}KB`;
  return `${n}B`;
}

function svcVariant(val: string): 'ok' | 'warn' | 'bad' | 'neutral' {
  const v = val.toLowerCase();
  if (v === 'connected' || v === 'ok' || v === 'true' || v === 'healthy') return 'ok';
  if (v === 'disconnected' || v === 'false' || v === 'unhealthy') return 'bad';
  if (v === 'degraded' || v === 'warn') return 'warn';
  return 'neutral';
}

function Dot({ variant }: { variant: 'ok' | 'warn' | 'bad' | 'neutral' | 'off' }) {
  const cls = variant === 'ok' ? 'dot--live' : variant === 'warn' ? 'dot--warn' : variant === 'bad' ? 'dot--dead' : 'dot--off';
  return <span className={`dot ${cls}`} />;
}

function truncKey(k: string, len = 18) {
  return k.length > len ? `${k.slice(0, len)}…` : k;
}

/* ─── Panel primitives ───────────────────────────────────────────────── */
function Panel({ title, titleVal, actions, children, grow2 }: {
  title: string;
  titleVal?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  grow2?: boolean;
}) {
  return (
    <div className={`panel${grow2 ? ' panel--grow2' : ''}`}>
      <div className="panel__head">
        <span className="panel__title">{title}</span>
        {titleVal && <span className="panel__title-val">{titleVal}</span>}
        {actions && <div className="panel__head-actions">{actions}</div>}
      </div>
      <div className="panel__body">{children}</div>
    </div>
  );
}

function StatRow({ label, value, variant }: { label: string; value: React.ReactNode; variant?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="stat-row">
      <span className="stat-row__label">{label}</span>
      <span className={`stat-row__value${variant ? ` stat-row__value--${variant}` : ''}`}>{value}</span>
    </div>
  );
}

/* ─── Stream Control panel ───────────────────────────────────────────── */
function StreamControlPanel({ globalProv, stream, token }: { globalProv: unknown; stream: unknown; token: boolean }) {
  const qc = useQueryClient();
  const setProvider = useMutation({
    mutationFn: (p: 'kite' | 'vortex') => admin.setGlobalProvider(p),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-global-provider'] });
      void qc.invalidateQueries({ queryKey: ['admin-stream-status'] });
    },
  });
  const startStream = useMutation({
    mutationFn: admin.startStream,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-stream-status'] }),
  });
  const stopStream = useMutation({
    mutationFn: admin.stopStream,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-stream-status'] }),
  });

  const gp = globalProv as Record<string, unknown> | undefined;
  const st = stream as Record<string, unknown> | undefined;
  const currentProvider = String(gp?.provider ?? '—');
  const isStreaming = st?.isStreaming === true;
  const tokenCount = Array.isArray(st?.subscribedTokens) ? st!.subscribedTokens.length :
    typeof st?.subscribedTokens === 'number' ? st!.subscribedTokens : '—';
  const providerName = String(st?.providerName ?? st?.connectedTo ?? currentProvider);

  if (!token) {
    return (
      <Panel title="STREAM CONTROL">
        <p className="muted" style={{ fontSize: 10, padding: '4px 0' }}>Set admin token in Settings</p>
      </Panel>
    );
  }

  return (
    <Panel title="STREAM CONTROL" titleVal={
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <Dot variant={isStreaming ? 'ok' : 'off'} />
        <span style={{ fontSize: 10, color: isStreaming ? 'var(--ok)' : 'var(--muted)', fontWeight: 700 }}>
          {isStreaming ? 'LIVE' : 'OFFLINE'}
        </span>
      </span>
    }>
      <div className="panel-section-title">PROVIDER</div>
      <div className="provider-btns" style={{ marginBottom: 6 }}>
        {(['kite', 'vortex'] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={`provider-btn ${currentProvider === p ? 'provider-btn--active' : ''}`}
            onClick={() => setProvider.mutate(p)}
            disabled={setProvider.isPending}
          >
            {p === 'kite' ? 'FALCON' : 'VAYU'}
            <span style={{ display: 'block', fontSize: 8, opacity: 0.6 }}>{p}</span>
          </button>
        ))}
      </div>
      <div className="panel-section-title">STREAM</div>
      <div className="stream-btns" style={{ marginBottom: 6 }}>
        <button type="button" className="stream-btn-start" onClick={() => startStream.mutate()} disabled={startStream.isPending || isStreaming}>
          ▶ START
        </button>
        <button type="button" className="stream-btn-stop" onClick={() => stopStream.mutate()} disabled={stopStream.isPending || !isStreaming}>
          ■ STOP
        </button>
      </div>
      <StatRow label="Provider" value={providerName.toUpperCase()} />
      <StatRow label="Tokens subscribed" value={fmtNum(tokenCount)} variant={typeof tokenCount === 'number' && tokenCount > 0 ? 'ok' : undefined} />
    </Panel>
  );
}

/* ─── Sys Metrics panel ──────────────────────────────────────────────── */
function SysMetricsPanel({ health }: { health: unknown }) {
  const d = health as Record<string, unknown> | undefined;
  const stats = d?.stats as Record<string, unknown> | undefined;
  const debug = d?.debug as Record<string, unknown> | undefined;
  const uptime = typeof stats?.uptime === 'number' ? stats.uptime : typeof d?.uptime === 'number' ? d.uptime : null;
  const heapUsed = typeof debug?.heap_used === 'number' ? debug.heap_used : null;
  const heapTotal = typeof debug?.heap_total === 'number' ? debug.heap_total : null;
  const heapPct = heapUsed && heapTotal ? Math.round((heapUsed / heapTotal) * 100) : null;

  const uptimeFmt = (s: number) => {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
  };

  return (
    <Panel title="SYS METRICS">
      <StatRow label="Status" value={String(d?.status ?? '—').toUpperCase()} variant={healthOverallStatus(health) === 'ok' ? 'ok' : 'bad'} />
      {uptime !== null && <StatRow label="Uptime" value={uptimeFmt(uptime)} />}
      {heapUsed !== null && (
        <StatRow label="Heap" value={
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {fmtBytes(heapUsed)}
            {heapPct !== null && (
              <div className="usage-bar usage-bar--ok" style={{ width: 36 }}>
                <div className="usage-bar__fill" style={{ width: `${heapPct}%` }} />
              </div>
            )}
          </span>
        } />
      )}
      {healthServiceRows(health).map((r) => (
        <StatRow
          key={r.label}
          label={r.label}
          value={r.value}
          variant={svcVariant(r.value) === 'ok' ? 'ok' : svcVariant(r.value) === 'bad' ? 'bad' : undefined}
        />
      ))}
    </Panel>
  );
}

/* ─── API Keys panel ─────────────────────────────────────────────────── */
function ApiKeysPanel({ token }: { token: boolean }) {
  const qc = useQueryClient();
  const { refetchInterval } = useRefreshInterval();
  const keys = useQuery({
    queryKey: ['admin-apikeys'],
    queryFn: admin.listApiKeys,
    enabled: token,
    refetchInterval,
  });
  const usage = useQuery({
    queryKey: ['admin-apikeys-usage', 1],
    queryFn: () => admin.listApiKeysUsage(1, 50),
    enabled: token,
    refetchInterval,
  });
  const deactivate = useMutation({
    mutationFn: admin.deactivateApiKey,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-apikeys'] }),
  });

  const usageMap = new Map<string, ApiKeyUsageItem>();
  usage.data?.items.forEach((u) => usageMap.set(u.key, u));

  const keyList: ApiKeyRow[] = Array.isArray(keys.data) ? keys.data : [];
  const total = usage.data?.total ?? keyList.length;

  if (!token) {
    return (
      <Panel title="API KEYS" titleVal="set token →" grow2>
        <p className="muted" style={{ fontSize: 10 }}>Set admin token in Settings to view keys</p>
      </Panel>
    );
  }

  return (
    <Panel title="API KEYS" titleVal={`${total} total`} grow2
      actions={<NavLink to="/keys" className="btn-xs">+ Manage</NavLink>}>
      <table className="data-table">
        <thead>
          <tr>
            <th>KEY</th>
            <th>TENANT</th>
            <th style={{ width: 30 }}>ST</th>
            <th>RATE/m</th>
            <th>WS RPS</th>
            <th>PROV</th>
            <th>HTTP REQ</th>
            <th>ACT</th>
          </tr>
        </thead>
        <tbody>
          {keyList.map((k) => {
            const u = usageMap.get(k.key);
            const httpReq = typeof u?.usage?.http_requests === 'number' ? u.usage.http_requests as number : 0;
            const rateLimit = k.rate_limit_per_minute ?? 600;
            const usagePct = Math.min(100, Math.round((httpReq / rateLimit) * 100));
            const barVariant = usagePct > 80 ? 'bad' : usagePct > 50 ? 'warn' : 'ok';

            return (
              <tr key={k.key}>
                <td className="cell-key">
                  <span title={k.key}>{truncKey(k.key)}</span>
                </td>
                <td className="cell-name" title={k.tenant_id}>{k.tenant_id}</td>
                <td className="cell-badge" style={{ textAlign: 'center' }}>
                  <Dot variant={k.is_active ? 'ok' : 'off'} />
                </td>
                <td className="cell-num">{fmtNum(k.rate_limit_per_minute)}</td>
                <td className="cell-num">{k.ws_subscribe_rps ?? '—'}</td>
                <td className="cell-muted">{k.provider ?? 'inherit'}</td>
                <td style={{ minWidth: 70 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span className="cell-num" style={{ minWidth: 30 }}>{fmtNum(httpReq)}</span>
                    <div className={`usage-bar usage-bar--${barVariant}`} style={{ flex: 1 }}>
                      <div className="usage-bar__fill" style={{ width: `${usagePct}%` }} />
                    </div>
                  </div>
                </td>
                <td>
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
                </td>
              </tr>
            );
          })}
          {keyList.length === 0 && (
            <tr>
              <td colSpan={8} className="cell-muted" style={{ textAlign: 'center', padding: '12px 8px' }}>
                {keys.isLoading ? 'Loading…' : 'No keys found'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

/* ─── Market Data panel ──────────────────────────────────────────────── */
function MarketDataPanel({ mdHealth }: { mdHealth: unknown }) {
  const d = mdHealth as Record<string, unknown> | undefined;
  const streaming = d?.streaming as Record<string, unknown> | undefined;
  const marketData = d?.marketData as Record<string, unknown> | undefined;
  const vortex = d?.vortex as Record<string, unknown> | undefined;

  const isStreaming = streaming?.isStreaming === true;

  return (
    <Panel title="MARKET DATA">
      <StatRow
        label="Streaming"
        value={isStreaming ? 'ACTIVE' : 'INACTIVE'}
        variant={isStreaming ? 'ok' : 'warn'}
      />
      <StatRow label="Provider" value={String(d?.provider ?? streaming?.providerName ?? '—').toUpperCase()} />
      {streaming?.providerName !== undefined && (
        <StatRow label="Stream provider" value={String(streaming.providerName).toUpperCase()} />
      )}
      {marketData && Object.entries(marketData).map(([k, v]) => (
        typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' ? (
          <StatRow
            key={k}
            label={k.replace(/([A-Z])/g, ' $1').toLowerCase()}
            value={typeof v === 'boolean' ? (v ? 'YES' : 'NO') : String(v)}
            variant={typeof v === 'boolean' ? (v ? 'ok' : 'bad') : undefined}
          />
        ) : null
      ))}
      {vortex?.httpOk !== undefined && (
        <StatRow
          label="Vayu HTTP"
          value={vortex.httpOk ? 'REACHABLE' : 'UNREACHABLE'}
          variant={vortex.httpOk ? 'ok' : 'bad'}
        />
      )}
      {marketDataSummaryRows(mdHealth).length === 0 && (
        <p className="muted" style={{ fontSize: 10 }}>Loading…</p>
      )}
    </Panel>
  );
}

/* ─── WS Status panel ────────────────────────────────────────────────── */
function WsStatusPanel({ ws, token }: { ws: unknown; token: boolean }) {
  if (!token) {
    return (
      <Panel title="WS CONNECTIONS" titleVal="—">
        <p className="muted" style={{ fontSize: 10 }}>Set admin token</p>
      </Panel>
    );
  }
  const d = ws as Record<string, unknown> | undefined;
  const conns = typeof d?.connections === 'number' ? d.connections : 0;
  const subs = Array.isArray(d?.subscriptions) ? d!.subscriptions : [];
  const byKey = Array.isArray(d?.byApiKey) ? d!.byApiKey as Array<Record<string, unknown>> : [];

  return (
    <Panel
      title="WS CONNECTIONS"
      titleVal={<><Dot variant={conns > 0 ? 'ok' : 'off'} /> {conns}</>}
      actions={<NavLink to="/ws" className="btn-xs">Admin →</NavLink>}
      grow2
    >
      <StatRow label="Namespace" value={String(d?.namespace ?? '/market-data')} />
      <StatRow label="Connections" value={fmtNum(conns)} variant={conns > 0 ? 'ok' : undefined} />
      <StatRow label="Subscr. groups" value={fmtNum(subs.length)} />
      <StatRow label="Redis" value={d?.redis_ok === true ? 'OK' : d?.redis_ok === false ? 'ISSUE' : '—'}
        variant={d?.redis_ok === true ? 'ok' : d?.redis_ok === false ? 'bad' : undefined} />
      {byKey.length > 0 && (
        <>
          <div className="panel-section-title" style={{ marginTop: 4 }}>PER-KEY BREAKDOWN</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>API KEY</th>
                <th className="cell-num">CONNS</th>
              </tr>
            </thead>
            <tbody>
              {byKey.slice(0, 10).map((row, i) => (
                <tr key={i}>
                  <td className="cell-key" title={String(row.apiKey ?? '')}>{truncKey(String(row.apiKey ?? ''))}</td>
                  <td className="cell-num">{fmtNum(row.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

/* ─── Abuse Summary panel ────────────────────────────────────────────── */
function AbuseSummaryPanel({ token }: { token: boolean }) {
  const qc = useQueryClient();
  const { refetchInterval } = useRefreshInterval();
  const list = useQuery({
    queryKey: ['admin-abuse', 1, undefined],
    queryFn: () => admin.listAbuseFlags(1, 10),
    enabled: token,
    refetchInterval,
  });
  const blockMut = useMutation({
    mutationFn: admin.manualBlockAbuse,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-abuse'] }),
  });

  if (!token) {
    return (
      <Panel title="SECURITY" titleVal="—">
        <p className="muted" style={{ fontSize: 10 }}>Set admin token</p>
      </Panel>
    );
  }

  const flags = list.data?.items ?? [];
  const blocked = flags.filter((f) => f.blocked).length;
  const highRisk = flags.filter((f) => f.risk_score >= 70).length;

  return (
    <Panel
      title="SECURITY"
      titleVal={<span style={{ color: highRisk > 0 ? 'var(--bad)' : 'var(--ok)' }}>
        {highRisk > 0 ? `${highRisk} HIGH RISK` : 'CLEAR'}
      </span>}
      actions={<NavLink to="/abuse" className="btn-xs">Full →</NavLink>}
      grow2
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
        <div className="stat-chip" style={{ flex: 1 }}>
          <div className="stat-chip__label">TOTAL FLAGS</div>
          <div className="stat-chip__value" style={{ fontSize: 18 }}>{list.data?.total ?? '—'}</div>
        </div>
        <div className="stat-chip" style={{ flex: 1 }}>
          <div className="stat-chip__label">BLOCKED</div>
          <div className="stat-chip__value" style={{ fontSize: 18, color: blocked > 0 ? 'var(--bad)' : 'inherit' }}>{blocked}</div>
        </div>
        <div className="stat-chip" style={{ flex: 1 }}>
          <div className="stat-chip__label">HIGH RISK</div>
          <div className="stat-chip__value" style={{ fontSize: 18, color: highRisk > 0 ? 'var(--bad)' : 'inherit' }}>{highRisk}</div>
        </div>
      </div>
      {flags.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>KEY</th>
              <th>RISK</th>
              <th style={{ width: 48 }}>BLK</th>
              <th>REASONS</th>
              <th>ACT</th>
            </tr>
          </thead>
          <tbody>
            {flags.slice(0, 8).map((f) => {
              const riskClass = f.risk_score >= 70 ? 'hi' : f.risk_score >= 30 ? 'med' : 'lo';
              return (
                <tr key={f.api_key}>
                  <td className="cell-key" title={f.api_key}>{truncKey(f.api_key, 14)}</td>
                  <td style={{ minWidth: 64 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span className="cell-num" style={{ fontSize: 10, minWidth: 24 }}>{f.risk_score}</span>
                      <div className={`risk-bar risk-bar--${riskClass}`} style={{ flex: 1 }}>
                        <div className="risk-bar__fill" style={{ width: `${f.risk_score}%` }} />
                      </div>
                    </div>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <Dot variant={f.blocked ? 'bad' : 'ok'} />
                  </td>
                  <td style={{ maxWidth: 90, overflow: 'hidden' }}>
                    {(f.reason_codes ?? []).slice(0, 2).map((r) => (
                      <span key={r} className="reason-pill">{r}</span>
                    ))}
                  </td>
                  <td>
                    {!f.blocked ? (
                      <button
                        type="button"
                        className="btn-xs btn-xs--danger"
                        onClick={() => blockMut.mutate({ api_key: f.api_key, reason: 'manual-cmd' })}
                        disabled={blockMut.isPending}
                      >
                        BLK
                      </button>
                    ) : (
                      <span className="cell-muted">blocked</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {flags.length === 0 && !list.isLoading && (
        <p className="muted" style={{ fontSize: 10, textAlign: 'center', padding: '12px 0' }}>No abuse flags detected</p>
      )}
    </Panel>
  );
}

/* ─── Data Plane Stats panel ─────────────────────────────────────────── */
function DataPlanePanel({ stats }: { stats: unknown }) {
  const cards = stockStatsMetricCards(stats);
  const d = stats as Record<string, unknown> | undefined;
  const batch = d?.batchStats as Record<string, unknown> | undefined;

  return (
    <Panel title="DATA PLANE">
      {cards.map((c) => (
        <StatRow key={c.label} label={c.label.toUpperCase()} value={c.value} />
      ))}
      {batch && (
        <>
          <StatRow label="PENDING REQS" value={fmtNum(batch.pendingRequests)} />
          <StatRow label="AVG BATCH SZ" value={fmtNum(batch.averageSize)} />
        </>
      )}
      {cards.length === 0 && <p className="muted" style={{ fontSize: 10 }}>Loading…</p>}
    </Panel>
  );
}

/* ─── Recent Events Panel ────────────────────────────────────────────── */
function eventColor(type: AdminStreamEvent['type']): string {
  if (type === 'connect') return 'var(--ok)';
  if (type === 'disconnect') return 'var(--warn, #f5a623)';
  return 'var(--bad)';
}

function eventIcon(type: AdminStreamEvent['type']): string {
  if (type === 'connect') return '●';
  if (type === 'disconnect') return '○';
  return '✕';
}

function fmtEvtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function RecentEventsPanel({ token }: { token: boolean }) {
  const eventsQ = useQuery({
    queryKey: ['admin-events'],
    queryFn: () => admin.getAdminEvents(20),
    refetchInterval: 15_000,
    enabled: token,
  });

  const events = (eventsQ.data ?? []) as AdminStreamEvent[];

  return (
    <Panel title="RECENT STREAM EVENTS">
      {eventsQ.isLoading && <p className="muted" style={{ fontSize: 10 }}>Loading…</p>}
      {!eventsQ.isLoading && events.length === 0 && (
        <p className="muted" style={{ fontSize: 10 }}>No events yet</p>
      )}
      {events.map((ev, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 10, marginBottom: 4, lineHeight: 1.5 }}>
          <span style={{ color: 'var(--muted)', fontFamily: 'ui-monospace, monospace', flexShrink: 0, fontSize: 9 }}>
            {fmtEvtTime(ev.ts)}
          </span>
          <span style={{ color: eventColor(ev.type), flexShrink: 0 }}>
            {eventIcon(ev.type)} {ev.type.replace('_', ' ')}
          </span>
          <span style={{ color: 'var(--text)', wordBreak: 'break-word', flex: 1 }}>
            {ev.message}
          </span>
        </div>
      ))}
    </Panel>
  );
}

/* ─── Main page ──────────────────────────────────────────────────────── */
export function OverviewPage() {
  const { token, health, mdHealth, stats, globalProv, stream, ws } = useLiveAdminMetrics();
  const hasToken = !!token;

  /* Health strip chips */
  const hStat = healthOverallStatus(health.data);
  const hdSvcs = healthServiceRows(health.data);
  const dbSvc = hdSvcs.find((r) => r.label === 'database');
  const redisSvc = hdSvcs.find((r) => r.label === 'redis');
  const streamData = stream.data as Record<string, unknown> | undefined;
  const wsData = ws.data as Record<string, unknown> | undefined;
  const mdData = mdHealth.data as Record<string, unknown> | undefined;
  const statsData = stats.data as Record<string, unknown> | undefined;
  const isStreaming = streamData?.isStreaming === true;
  const wsConns = typeof wsData?.connections === 'number' ? wsData.connections : 0;
  const providerName = String(streamData?.providerName ?? streamData?.connectedTo ?? (mdData?.provider ?? '—')).toUpperCase();

  /* Stat cluster */
  const instruments = typeof statsData?.instruments === 'number' ? statsData.instruments : null;
  const activeSubs = typeof statsData?.activeSubscriptions === 'number' ? statsData.activeSubscriptions : null;
  const totalConns = typeof (statsData?.connectionStats as Record<string, unknown> | undefined)?.totalConnections === 'number'
    ? (statsData!.connectionStats as Record<string, unknown>).totalConnections
    : wsConns;

  return (
    <div className="cc-page">
      {/* ── Health Strip ──────────────────────────────────────── */}
      <div className="cc-health-strip">
        <span className="cc-chip cc-chip--neutral" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', marginRight: 4 }}>
          COMMAND CENTER
        </span>
        <span className={`cc-chip cc-chip--${hStat}`}>
          <Dot variant={hStat} />
          <span className="cc-chip__label">API</span>
          {String((health.data as Record<string, unknown> | undefined)?.status ?? '…').toUpperCase()}
        </span>
        {dbSvc && (
          <span className={`cc-chip cc-chip--${svcVariant(dbSvc.value)}`}>
            <Dot variant={svcVariant(dbSvc.value)} />
            <span className="cc-chip__label">DB</span>
            {dbSvc.value.toUpperCase()}
          </span>
        )}
        {redisSvc && (
          <span className={`cc-chip cc-chip--${svcVariant(redisSvc.value)}`}>
            <Dot variant={svcVariant(redisSvc.value)} />
            <span className="cc-chip__label">REDIS</span>
            {redisSvc.value.toUpperCase()}
          </span>
        )}
        <span className={`cc-chip cc-chip--${isStreaming ? 'ok' : 'warn'}`}>
          <Dot variant={isStreaming ? 'ok' : 'off'} />
          <span className="cc-chip__label">STREAM</span>
          {isStreaming ? providerName : 'OFFLINE'}
        </span>
        <span className={`cc-chip cc-chip--${wsConns > 0 ? 'ok' : 'neutral'}`}>
          <Dot variant={wsConns > 0 ? 'ok' : 'off'} />
          <span className="cc-chip__label">WS</span>
          {wsConns} CONN
        </span>
        {!hasToken && (
          <span className="cc-chip cc-chip--warn" style={{ marginLeft: 'auto' }}>
            ⚠ Set admin token in <NavLink to="/settings" style={{ color: 'var(--warn)' }}>Settings</NavLink>
          </span>
        )}
      </div>

      {/* ── Stat Cluster ──────────────────────────────────────── */}
      <div className="stat-cluster">
        {instruments !== null && (
          <div className="stat-chip">
            <div className="stat-chip__label">INSTRUMENTS</div>
            <div className="stat-chip__value">{fmtNum(instruments)}</div>
          </div>
        )}
        {activeSubs !== null && (
          <div className="stat-chip">
            <div className="stat-chip__label">ACTIVE SUBS</div>
            <div className="stat-chip__value">{fmtNum(activeSubs)}</div>
          </div>
        )}
        <div className="stat-chip">
          <div className="stat-chip__label">WS CONNS</div>
          <div className="stat-chip__value">{fmtNum(totalConns)}</div>
        </div>
        <div className="stat-chip">
          <div className="stat-chip__label">PROVIDER</div>
          <div className="stat-chip__value" style={{ fontSize: 13 }}>{providerName}</div>
        </div>
      </div>

      {/* ── Main Grid ─────────────────────────────────────────── */}
      <div className="cc-grid" style={{ flex: 1, minHeight: 0 }}>
        {/* Left column */}
        <div className="cc-col-left">
          <StreamControlPanel globalProv={globalProv.data} stream={stream.data} token={hasToken} />
          <SysMetricsPanel health={health.data} />
          <DataPlanePanel stats={stats.data} />
        </div>

        {/* Mid column */}
        <div className="cc-col-mid">
          <ApiKeysPanel token={hasToken} />
          <MarketDataPanel mdHealth={mdHealth.data} />
        </div>

        {/* Right column */}
        <div className="cc-col-right">
          <WsStatusPanel ws={ws.data} token={hasToken} />
          <AbuseSummaryPanel token={hasToken} />
          <RecentEventsPanel token={hasToken} />
        </div>
      </div>
    </div>
  );
}
