/**
 * @file OverviewPage.tsx
 * @module admin-dashboard
 * @description Live operational overview with structured metrics and raw JSON fallback.
 * @updated 2026-03-28
 */

import { NavLink } from 'react-router-dom';
import {
  adminProviderLabel,
  healthOverallStatus,
  healthServiceRows,
  marketDataSummaryRows,
  stockStatsExtraRows,
  stockStatsMetricCards,
  streamSummaryRows,
  wsStatusSummaryRows,
} from '../lib/views/overview-views';
import { ErrorInline } from '../components/ErrorInline';
import { KeyValueGrid } from '../components/KeyValueGrid';
import { MetricCard } from '../components/MetricCard';
import { RawJsonDetails } from '../components/RawJsonDetails';
import { StatusBadge } from '../components/StatusBadge';
import { useLiveAdminMetrics } from '../hooks/useLiveAdminMetrics';
import { useRefreshInterval } from '../hooks/useRefreshInterval';

export function OverviewPage() {
  const { presetId, refetchInterval } = useRefreshInterval();
  const { token, health, mdHealth, stats, globalProv, stream, ws } = useLiveAdminMetrics();

  const pollSec = refetchInterval === false ? 0 : Number(refetchInterval) / 1000;
  const pollLabel = refetchInterval === false ? 'paused (manual)' : `${pollSec}s (${presetId})`;

  const hStat = health.data ? healthOverallStatus(health.data) : 'neutral';
  const hBadge =
    hStat === 'ok' ? (
      <StatusBadge variant="ok">Healthy</StatusBadge>
    ) : hStat === 'bad' ? (
      <StatusBadge variant="bad">Unhealthy</StatusBadge>
    ) : (
      <StatusBadge variant="neutral">Unknown</StatusBadge>
    );

  return (
    <>
      <section className="card">
        <h2>Service health</h2>
        <p className="muted">Live snapshots every {pollLabel} from public endpoints.</p>
        <div className="overview-strip">
          {hBadge}
          <span className="muted">API</span>
        </div>
        <ErrorInline message={health.isError ? (health.error as Error).message : null} />
        {health.data && (
          <>
            <KeyValueGrid
              rows={[
                { label: 'Status', value: String((health.data as Record<string, unknown>).status ?? '—') },
                ...healthServiceRows(health.data).map((r) => ({ label: r.label, value: r.value })),
              ]}
            />
            <RawJsonDetails value={health.data} summary="Raw: GET /api/health" />
          </>
        )}
      </section>

      <section className="card">
        <h2>Market data</h2>
        <ErrorInline message={mdHealth.isError ? (mdHealth.error as Error).message : null} />
        {mdHealth.data && (
          <>
            <KeyValueGrid rows={marketDataSummaryRows(mdHealth.data).map((r) => ({ label: r.label, value: r.value }))} />
            <RawJsonDetails value={mdHealth.data} summary="Raw: GET /api/health/market-data" />
          </>
        )}
      </section>

      <section className="card">
        <h2>Data plane stats</h2>
        <ErrorInline message={stats.isError ? (stats.error as Error).message : null} />
        {stats.data && (
          <>
            <div className="metric-grid">
              {stockStatsMetricCards(stats.data).map((m) => (
                <MetricCard key={m.label} label={m.label} value={m.value} hint={m.hint} />
              ))}
            </div>
            <KeyValueGrid rows={stockStatsExtraRows(stats.data).map((r) => ({ label: r.label, value: r.value }))} />
            <RawJsonDetails value={stats.data} summary="Raw: GET /api/stock/stats" />
          </>
        )}
      </section>

      <section className="card">
        <h2>Admin live</h2>
        {!token && <p className="muted">Set an admin token under Settings for provider, stream, and WebSocket summaries.</p>}
        {token && (
          <>
            <div className="overview-strip">
              <span>
                <strong>Global provider:</strong>{' '}
                <StatusBadge variant="neutral">{adminProviderLabel(globalProv.data)}</StatusBadge>
              </span>
              {stream.data && (
                <span>
                  <strong>Streaming:</strong>{' '}
                  <StatusBadge variant={(stream.data as Record<string, unknown>).isStreaming ? 'ok' : 'warn'}>
                    {(stream.data as Record<string, unknown>).isStreaming ? 'On' : 'Off'}
                  </StatusBadge>
                </span>
              )}
              {ws.data && typeof (ws.data as Record<string, unknown>).connections === 'number' && (
                <span>
                  <strong>WS connections:</strong>{' '}
                  {String((ws.data as Record<string, unknown>).connections)}{' '}
                  <NavLink to="/ws">Open WebSocket admin</NavLink>
                </span>
              )}
            </div>

            <ErrorInline message={globalProv.isError ? (globalProv.error as Error).message : null} />
            <ErrorInline message={stream.isError ? (stream.error as Error).message : null} />
            <ErrorInline message={ws.isError ? (ws.error as Error).message : null} />

            <h3 className="muted" style={{ marginTop: 16 }}>
              Provider
            </h3>
            {globalProv.data && (
              <>
                <KeyValueGrid rows={[{ label: 'Name', value: adminProviderLabel(globalProv.data) }]} />
                <RawJsonDetails value={globalProv.data} />
              </>
            )}

            <h3 className="muted" style={{ marginTop: 16 }}>
              Stream
            </h3>
            {stream.data && (
              <>
                <KeyValueGrid rows={streamSummaryRows(stream.data).map((r) => ({ label: r.label, value: r.value }))} />
                <RawJsonDetails value={stream.data} />
              </>
            )}

            <h3 className="muted" style={{ marginTop: 16 }}>
              WebSocket
            </h3>
            {ws.data && (
              <>
                <KeyValueGrid rows={wsStatusSummaryRows(ws.data).map((r) => ({ label: r.label, value: r.value }))} />
                <RawJsonDetails value={ws.data} />
              </>
            )}
          </>
        )}
      </section>
    </>
  );
}
