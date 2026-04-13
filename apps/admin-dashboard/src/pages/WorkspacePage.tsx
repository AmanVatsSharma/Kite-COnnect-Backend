/**
 * @file WorkspacePage.tsx
 * @module admin-dashboard
 * @description Dense multi-panel workspace reusing live admin metrics queries.
 * @author BharatERP
 * @created 2026-03-28
 * @updated 2026-03-28
 */

import { NavLink } from 'react-router-dom';
import { useLiveAdminMetrics } from '../hooks/useLiveAdminMetrics';
import {
  adminProviderLabel,
  healthOverallStatus,
  healthServiceRows,
  marketDataSummaryRows,
  stockStatsMetricCards,
  streamSummaryRows,
  wsStatusSummaryRows,
} from '../lib/views/overview-views';
import { ErrorInline } from '../components/ErrorInline';
import { StatusBadge } from '../components/StatusBadge';
import { useRefreshInterval } from '../hooks/useRefreshInterval';

export function WorkspacePage() {
  const { presetId, refetchInterval } = useRefreshInterval();
  const { token, health, mdHealth, stats, globalProv, stream, ws } = useLiveAdminMetrics();

  const hStat = health.data ? healthOverallStatus(health.data) : 'neutral';
  const pollLabel =
    refetchInterval === false ? 'paused' : `${Number(refetchInterval) / 1000}s · ${presetId}`;

  return (
    <div className="workspace-page">
      <header className="workspace-header">
        <h1 className="workspace-title">Workspace</h1>
        <span className="muted terminal-mono">Poll {pollLabel}</span>
      </header>

      <div className="workspace-grid">
        <section className="workspace-panel">
          <h2 className="workspace-panel__title">Service health</h2>
          <ErrorInline message={health.isError ? (health.error as Error).message : null} />
          {health.data ? (
            <div className="workspace-panel__body">
              <div className="workspace-strip">
                {hStat === 'ok' ? (
                  <StatusBadge variant="ok">OK</StatusBadge>
                ) : hStat === 'bad' ? (
                  <StatusBadge variant="bad">DOWN</StatusBadge>
                ) : (
                  <StatusBadge variant="neutral">?</StatusBadge>
                )}
                <span className="terminal-mono muted">{String((health.data as Record<string, unknown>).status ?? '')}</span>
              </div>
              <dl className="workspace-kv">
                {healthServiceRows(health.data).slice(0, 6).map((r) => (
                  <div key={r.label} className="workspace-kv__row">
                    <dt>{r.label}</dt>
                    <dd className="terminal-mono">{r.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <p className="muted">Loading…</p>
          )}
        </section>

        <section className="workspace-panel">
          <h2 className="workspace-panel__title">Market data</h2>
          <ErrorInline message={mdHealth.isError ? (mdHealth.error as Error).message : null} />
          {mdHealth.data ? (
            <dl className="workspace-kv">
              {marketDataSummaryRows(mdHealth.data).slice(0, 8).map((r) => (
                <div key={r.label} className="workspace-kv__row">
                  <dt>{r.label}</dt>
                  <dd className="terminal-mono">{r.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="muted">Loading…</p>
          )}
        </section>

        <section className="workspace-panel">
          <h2 className="workspace-panel__title">Data plane</h2>
          <ErrorInline message={stats.isError ? (stats.error as Error).message : null} />
          {stats.data ? (
            <div className="workspace-metrics">
              {stockStatsMetricCards(stats.data).map((m) => (
                <div key={m.label} className="workspace-metric">
                  <div className="workspace-metric__l">{m.label}</div>
                  <div className="workspace-metric__v terminal-mono">{m.value}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">Loading…</p>
          )}
        </section>

        <section className="workspace-panel workspace-panel--wide">
          <h2 className="workspace-panel__title">Admin live</h2>
          {!token && <p className="muted">Set admin token under Settings</p>}
          {token && (
            <>
              <ErrorInline message={globalProv.isError ? (globalProv.error as Error).message : null} />
              <ErrorInline message={stream.isError ? (stream.error as Error).message : null} />
              <ErrorInline message={ws.isError ? (ws.error as Error).message : null} />
              <div className="workspace-admin-cols">
                <div>
                  <h3 className="workspace-subtitle">Provider</h3>
                  {globalProv.data ? (
                    <p className="terminal-mono">
                      <StatusBadge variant="neutral">{adminProviderLabel(globalProv.data)}</StatusBadge>
                    </p>
                  ) : (
                    <p className="muted">…</p>
                  )}
                </div>
                <div>
                  <h3 className="workspace-subtitle">Stream</h3>
                  {stream.data ? (
                    <dl className="workspace-kv">
                      {streamSummaryRows(stream.data).slice(0, 5).map((r) => (
                        <div key={r.label} className="workspace-kv__row">
                          <dt>{r.label}</dt>
                          <dd className="terminal-mono">{r.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="muted">…</p>
                  )}
                </div>
                <div>
                  <h3 className="workspace-subtitle">WebSocket</h3>
                  {ws.data ? (
                    <>
                      <dl className="workspace-kv">
                        {wsStatusSummaryRows(ws.data).map((r) => (
                          <div key={r.label} className="workspace-kv__row">
                            <dt>{r.label}</dt>
                            <dd className="terminal-mono">{r.value}</dd>
                          </div>
                        ))}
                      </dl>
                      <NavLink to="/ws" className="workspace-link">
                        Open WS admin →
                      </NavLink>
                    </>
                  ) : (
                    <p className="muted">…</p>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
