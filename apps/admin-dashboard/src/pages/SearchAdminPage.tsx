/**
 * @file apps/admin-dashboard/src/pages/SearchAdminPage.tsx
 * @module admin-dashboard
 * @description Search-admin control panel. Single-page view of MeiliSearch index
 *              health (doc count, indexing flag, settings) and the Redis-stored
 *              selection-signal candidate list (queries that retail users picked
 *              specific symbols for — these become dynamic synonyms on the next
 *              `synonyms-apply` indexer run).
 *
 * Exports:
 *   - SearchAdminPage — React page mounted at /search-admin in the dashboard
 *
 * Depends on:
 *   - search-api.ts → getSearchAdminOverview() — single GET /api/search/admin/overview
 *
 * Side-effects:
 *   - One GET /api/search/admin/overview on mount + on refresh-interval tick.
 *
 * Key invariants:
 *   - All requests carry x-admin-token from sessionStorage. If the token is missing,
 *     the panel renders the empty state and prompts to set the token via Settings.
 *   - The page is read-only — no mutation buttons in V1. To rebuild synonyms,
 *     run the indexer container with INDEXER_MODE=synonyms-apply.
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-01
 */

import { useQuery } from '@tanstack/react-query';
import { getAdminToken } from '../lib/api-client';
import { getSearchAdminOverview, type SearchAdminOverview } from '../lib/search-api';
import { useRefreshInterval } from '../hooks/useRefreshInterval';

/** Format a number with Indian-locale grouping; safe for null/undefined. */
function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN');
}

function StatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  const bg = ok ? 'var(--ok)' : warn ? 'var(--warn)' : 'var(--bad)';
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: bg,
        marginRight: 6,
        verticalAlign: 'middle',
      }}
    />
  );
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="stat-row">
      <span className="stat-row__label">{label}</span>
      <span className="stat-row__value">{value}</span>
    </div>
  );
}

function MeiliBlock({ data }: { data: SearchAdminOverview['meili'] }) {
  const indexing = data.isIndexing;
  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">MEILISEARCH INDEX</span>
        <span className="panel__title-val">
          <StatusDot ok={!indexing} warn={!!indexing} />
          {indexing ? 'INDEXING…' : 'IDLE'}
        </span>
      </div>
      <div className="panel__body">
        <StatRow label="Index name" value={<code>{data.indexName}</code>} />
        <StatRow label="Documents" value={fmt(data.numberOfDocuments)} />
        <StatRow
          label="Synonyms (static)"
          value={data.settings.synonymCount != null ? fmt(data.settings.synonymCount) : '—'}
        />
        <StatRow
          label="Searchable attrs"
          value={
            <span className="cell-muted" style={{ fontSize: 10 }}>
              {data.settings.searchableAttributes?.join(', ') ?? '—'}
            </span>
          }
        />
        <StatRow
          label="Filterable attrs"
          value={
            <span className="cell-muted" style={{ fontSize: 10 }}>
              {data.settings.filterableAttributes?.join(', ') ?? '—'}
            </span>
          }
        />
      </div>
    </div>
  );
}

function FieldDistributionBlock({ dist }: { dist: Record<string, number> | null }) {
  if (!dist || Object.keys(dist).length === 0) return null;
  const rows = Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);
  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">FIELD COVERAGE</span>
        <span className="panel__title-val cell-muted">
          how many docs have each field populated
        </span>
      </div>
      <div className="panel__body" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>FIELD</th>
              <th className="cell-num">DOCS WITH VALUE</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([field, count]) => (
              <tr key={field}>
                <td><code>{field}</code></td>
                <td className="cell-num">{fmt(count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SelectionSignalsBlock({ data }: { data: SearchAdminOverview['selectionSignals'] }) {
  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">SELECTION SIGNALS</span>
        <span className="panel__title-val cell-muted">
          {data.scanned > 0
            ? `top ${data.top.length} of ${fmt(data.scanned)} scanned`
            : 'no signals yet'}
        </span>
      </div>
      <div className="panel__body" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>QUERY</th>
              <th>SELECTED SYMBOL</th>
              <th className="cell-num">COUNT</th>
            </tr>
          </thead>
          <tbody>
            {data.top.length === 0 ? (
              <tr>
                <td colSpan={3} className="cell-muted" style={{ textAlign: 'center', padding: 20 }}>
                  No selection telemetry recorded. Selections post to
                  &nbsp;<code>POST /api/search/telemetry/selection</code>&nbsp;
                  build this list as users pick search results.
                </td>
              </tr>
            ) : (
              data.top.map((row, i) => (
                <tr key={`${row.q}|${row.symbol}|${i}`}>
                  <td><code>{row.q}</code></td>
                  <td style={{ fontWeight: 600 }}>{row.symbol}</td>
                  <td className="cell-num">{fmt(row.count)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PopularQueriesBlock({ data }: { data: SearchAdminOverview['popularQueries'] }) {
  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">POPULAR QUERIES</span>
        <span className="panel__title-val cell-muted">
          aggregated across symbols ({data.length})
        </span>
      </div>
      <div className="panel__body" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>QUERY</th>
              <th className="cell-num">SELECTIONS</th>
              <th className="cell-num">UNIQUE SYMBOLS</th>
            </tr>
          </thead>
          <tbody>
            {data.length === 0 ? (
              <tr>
                <td colSpan={3} className="cell-muted" style={{ textAlign: 'center', padding: 16 }}>
                  No data yet — populated from selection telemetry.
                </td>
              </tr>
            ) : (
              data.map((row, i) => (
                <tr key={`${row.q}|${i}`}>
                  <td><code>{row.q}</code></td>
                  <td className="cell-num">{fmt(row.totalSelections)}</td>
                  <td className="cell-num">{fmt(row.uniqueSymbols)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ErrorsBlock({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="panel" style={{ marginBottom: 10 }}>
      <div className="panel__head">
        <span className="panel__title" style={{ color: 'var(--bad)' }}>BACKEND ERRORS</span>
      </div>
      <div className="panel__body">
        {errors.map((e, i) => (
          <div key={i} style={{ fontSize: 11, color: 'var(--bad)', marginBottom: 4 }}>
            • {e}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SearchAdminPage() {
  const { refetchInterval } = useRefreshInterval();
  const hasToken = !!getAdminToken();

  const { data, isFetching, isError, error } = useQuery({
    queryKey: ['search-admin-overview'],
    queryFn: () => getSearchAdminOverview(30),
    enabled: hasToken,
    refetchInterval,
    staleTime: typeof refetchInterval === 'number' ? Math.min(refetchInterval, 5_000) : 5_000,
    retry: 1,
  });

  if (!hasToken) {
    return (
      <div className="page-root" style={{ padding: '12px 16px' }}>
        <div className="panel">
          <div className="panel__body" style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>
            Admin token required. Set it in <a href="/dashboard/settings">Settings</a>.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-root" style={{ padding: '12px 16px' }}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="panel__head" style={{ marginBottom: 10 }}>
        <span className="panel__title">SEARCH ADMIN</span>
        <span className="panel__title-val cell-muted" style={{ fontSize: 10 }}>
          MeiliSearch · synonym signals · last refreshed {data?.data.generatedAt?.substring(11, 19) ?? '—'}
          {isFetching && <span style={{ marginLeft: 8 }}>· refreshing…</span>}
        </span>
      </div>

      {isError && (
        <div className="panel" style={{ marginBottom: 10 }}>
          <div className="panel__body" style={{ color: 'var(--bad)', fontSize: 11 }}>
            Failed to load admin overview: {(error as Error)?.message ?? 'Unknown error'}
          </div>
        </div>
      )}

      {data?.data && (
        <>
          <ErrorsBlock errors={data.data.errors} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <MeiliBlock data={data.data.meili} />
            <FieldDistributionBlock dist={data.data.meili.fieldDistribution} />
          </div>

          <div style={{ marginBottom: 10 }}>
            <PopularQueriesBlock data={data.data.popularQueries} />
          </div>

          <div>
            <SelectionSignalsBlock data={data.data.selectionSignals} />
          </div>

          {/* ── How-to footer ────────────────────────────────────────────── */}
          <div className="panel" style={{ marginTop: 10 }}>
            <div className="panel__body" style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.6 }}>
              <strong>Index rebuild:</strong> the indexer runs in a separate container.
              To apply selection signals as dynamic synonyms, run{' '}
              <code>docker compose run --rm -e INDEXER_MODE=synonyms-apply search-indexer</code>.
              <br />
              <strong>Full reindex:</strong> set{' '}
              <code>INDEXER_MODE=backfill</code> on the indexer container.
              <br />
              <strong>Public brand mapping:</strong> Falcon = kite (Indian equity),
              Vayu = vortex (F&amp;O), Atlas = massive (US/global), Drift = binance (crypto).
            </div>
          </div>
        </>
      )}
    </div>
  );
}
