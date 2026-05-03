/**
 * @file apps/admin-dashboard/src/pages/SearchPage.tsx
 * @module admin-dashboard
 * @description Universal instrument search UI backed by the search-api microservice.
 *              Lets admins test and browse instrument search with live LTP prices,
 *              see which provider streams each instrument (VIA badge with public brand
 *              + internal name on hover), and copy a ready-made WS subscribe payload
 *              to the clipboard for quick testing.
 *
 * Exports:
 *   - SearchPage — React page component, mounted at /search in the admin dashboard
 *
 * Depends on:
 *   - search-api.ts — typed client for /api/search endpoints (admin variant)
 *
 * Side-effects:
 *   - GET /api/search?include=internal on every debounced query input
 *   - navigator.clipboard.writeText on copy-WS-payload click
 *
 * Key invariants:
 *   - Queries only fire when q.length >= 2
 *   - LTP cell shows STALE pill when priceStatus === 'stale' (off-hours / no mapping)
 *   - VIA badge shows public brand (Falcon/Vayu/Atlas/Drift) and tooltips the internal
 *     provider name (kite/vortex/massive/binance) for admin debugging
 *   - Copy-WS-payload button always copies a payload keyed by UIR id — provider-agnostic,
 *     mirrors the universal subscribe contract used by /ws
 *   - The dashboard is admin — the lib defaults to ?include=internal + x-admin-token
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-01
 */

import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  searchInstruments,
  type SearchResultItem,
  type SearchFilters,
  type PublicProviderName,
  PUBLIC_PROVIDER_LABELS,
} from '../lib/search-api';

const EXCHANGES = ['', 'NSE', 'BSE', 'MCX', 'BFO', 'NFO', 'BINANCE', 'NASDAQ', 'NYSE'];
const SEGMENTS = ['', 'EQ', 'FO', 'CUR', 'COM', 'spot', 'forex', 'crypto'];
const INSTRUMENT_TYPES = ['', 'EQ', 'FUT', 'CE', 'PE', 'ETF'];
const STREAM_PROVIDERS: ('' | PublicProviderName)[] = ['', 'falcon', 'vayu', 'atlas', 'drift'];
const LIMITS = [10, 20, 50];

function fmt(n: number | undefined | null, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', { maximumFractionDigits: decimals });
}

function fmtRs(n: number | undefined | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `₹${fmt(n)}`;
}

/** LTP cell: green ₹ if live, "STALE" pill otherwise. */
function LtpCell({ value, priceStatus }: { value?: number | null; priceStatus?: 'live' | 'stale' }) {
  const formatted = fmtRs(value);
  if (formatted) {
    return <span style={{ color: 'var(--ok)', fontWeight: 600 }}>{formatted}</span>;
  }
  // Backwards-compat: if priceStatus isn't set (older search-api), fall back to em-dash.
  if (priceStatus !== 'stale') return <span className="cell-muted">—</span>;
  return (
    <span
      style={{
        fontSize: 9,
        padding: '2px 5px',
        borderRadius: 3,
        background: 'rgba(148, 163, 184, 0.15)',
        color: 'var(--muted)',
        border: '1px solid var(--border)',
        letterSpacing: 0.4,
        fontWeight: 600,
      }}
    >
      STALE
    </span>
  );
}

function Badge({ label }: { label?: string | null }) {
  if (!label) return <span className="cell-muted">—</span>;
  return (
    <span
      className="badge"
      style={{
        fontSize: 9,
        padding: '2px 5px',
        borderRadius: 3,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        letterSpacing: 0.4,
      }}
    >
      {label}
    </span>
  );
}

/**
 * VIA badge: shows the public brand name (Falcon/Vayu/Atlas/Drift) with the internal
 * provider name in the tooltip — so admins still know what's actually serving the
 * ticks, while the brand layer is what we'd ship to retail clients.
 */
function ProviderBadge({
  provider,
  internalName,
}: {
  provider?: PublicProviderName;
  internalName?: string;
}) {
  if (!provider) return <span className="cell-muted">—</span>;
  const meta = PUBLIC_PROVIDER_LABELS[provider];
  return (
    <span
      title={internalName ? `Internal: ${internalName}\nCovers: ${meta.covers}` : meta.covers}
      style={{
        fontSize: 9,
        padding: '2px 6px',
        borderRadius: 3,
        background: meta.bg,
        color: meta.color,
        border: `1px solid ${meta.color}33`,
        letterSpacing: 0.5,
        fontWeight: 700,
        textTransform: 'uppercase',
      }}
    >
      {meta.name}
    </span>
  );
}

/**
 * Copy-WS-payload button. Builds the exact JSON the /ws gateway expects and writes
 * it to the clipboard. Useful for admins testing live data via the test WS client
 * (test-websocket-client.html) or any debugging tool — paste, send, see ticks.
 */
function CopyWsPayloadButton({ uirId }: { uirId: number }) {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(async () => {
    const payload = JSON.stringify({
      event: 'subscribe',
      data: { instruments: [uirId], mode: 'ltp' },
    });
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API may be blocked in some contexts (insecure origin). Fall back to no-op.
      setCopied(false);
    }
  }, [uirId]);

  return (
    <button
      type="button"
      onClick={onClick}
      title={`Copy WS subscribe payload for UID ${uirId}`}
      style={{
        fontSize: 10,
        padding: '2px 6px',
        borderRadius: 3,
        background: copied ? 'rgba(16, 185, 129, 0.2)' : 'var(--surface)',
        color: copied ? 'var(--ok)' : 'var(--muted)',
        border: '1px solid var(--border)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        letterSpacing: 0.4,
      }}
    >
      {copied ? '✓ COPIED' : 'COPY WS'}
    </button>
  );
}

export function SearchPage() {
  const [rawQ, setRawQ] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(20);
  const [filters, setFilters] = useState<SearchFilters>({});
  const [ltpOnly, setLtpOnly] = useState(false);

  // Debounce: fire query 350ms after the user stops typing
  useEffect(() => {
    const t = setTimeout(() => setQ(rawQ.trim()), 350);
    return () => clearTimeout(t);
  }, [rawQ]);

  const setFilter = useCallback((key: keyof SearchFilters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value || undefined }));
  }, []);

  const { data, isFetching, isError, error } = useQuery({
    queryKey: ['search', q, limit, filters, ltpOnly],
    queryFn: () => searchInstruments(q, limit, { ...filters, ltp_only: ltpOnly }),
    enabled: q.length >= 2,
    staleTime: 5_000,
    retry: 1,
  });

  const results: SearchResultItem[] = data?.data ?? [];

  return (
    <div className="page-root" style={{ padding: '12px 16px' }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="panel__head" style={{ marginBottom: 10 }}>
        <span className="panel__title">INSTRUMENT SEARCH</span>
        <span className="panel__title-val" style={{ color: 'var(--muted)', fontSize: 10 }}>
          via search-api · MeiliSearch
        </span>
      </div>

      {/* ── Query bar ──────────────────────────────────────────────────── */}
      <div className="panel" style={{ marginBottom: 10 }}>
        <div className="panel__body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="input-mono"
            style={{ flex: '1 1 200px', minWidth: 160 }}
            placeholder="Search symbol… (e.g. RELIANCE, NIFTY, SBIN)"
            value={rawQ}
            onChange={(e) => setRawQ(e.target.value)}
            autoFocus
          />

          <select
            className="input-mono"
            style={{ width: 90 }}
            value={filters.exchange ?? ''}
            onChange={(e) => setFilter('exchange', e.target.value)}
          >
            <option value="">Exchange</option>
            {EXCHANGES.filter(Boolean).map((ex) => (
              <option key={ex} value={ex}>{ex}</option>
            ))}
          </select>

          <select
            className="input-mono"
            style={{ width: 80 }}
            value={filters.segment ?? ''}
            onChange={(e) => setFilter('segment', e.target.value)}
          >
            <option value="">Segment</option>
            {SEGMENTS.filter(Boolean).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <select
            className="input-mono"
            style={{ width: 80 }}
            value={filters.instrumentType ?? ''}
            onChange={(e) => setFilter('instrumentType', e.target.value)}
          >
            <option value="">Type</option>
            {INSTRUMENT_TYPES.filter(Boolean).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          <select
            className="input-mono"
            style={{ width: 90 }}
            value={filters.streamProvider ?? ''}
            onChange={(e) => setFilter('streamProvider', e.target.value)}
            title="Filter by which provider streams this instrument"
          >
            <option value="">VIA (any)</option>
            {STREAM_PROVIDERS.filter(Boolean).map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>

          <select
            className="input-mono"
            style={{ width: 60 }}
            value={String(limit)}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            {LIMITS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>

          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={ltpOnly}
              onChange={(e) => setLtpOnly(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            LTP only
          </label>

          {isFetching && (
            <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 4 }}>searching…</span>
          )}
        </div>
      </div>

      {/* ── Error ──────────────────────────────────────────────────────── */}
      {isError && (
        <div className="panel" style={{ marginBottom: 10 }}>
          <div className="panel__body">
            <span style={{ color: 'var(--bad)', fontSize: 11 }}>
              Search failed: {(error as Error)?.message ?? 'Unknown error'}
            </span>
          </div>
        </div>
      )}

      {/* ── Empty state ────────────────────────────────────────────────── */}
      {!isFetching && q.length >= 2 && !isError && results.length === 0 && (
        <div className="panel">
          <div className="panel__body" style={{ color: 'var(--muted)', fontSize: 11, textAlign: 'center', padding: '20px 0' }}>
            No instruments found for "{q}"
          </div>
        </div>
      )}

      {q.length > 0 && q.length < 2 && (
        <div className="panel">
          <div className="panel__body" style={{ color: 'var(--muted)', fontSize: 11, padding: '12px 0' }}>
            Type at least 2 characters to search
          </div>
        </div>
      )}

      {/* ── Results table ──────────────────────────────────────────────── */}
      {results.length > 0 && (
        <div className="panel">
          <div className="panel__head">
            <span className="panel__title">RESULTS</span>
            <span className="panel__title-val">{results.length} instruments</span>
          </div>
          <div className="panel__body" style={{ overflowX: 'auto', padding: 0 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>SYMBOL</th>
                  <th>NAME</th>
                  <th>EXCHANGE</th>
                  <th title="Which provider streams this instrument's live ticks">VIA</th>
                  <th>SEGMENT</th>
                  <th>TYPE</th>
                  <th>EXPIRY</th>
                  <th className="cell-num">STRIKE</th>
                  <th className="cell-num">LTP</th>
                  <th className="cell-num">LOT</th>
                  <th className="cell-num">UID</th>
                  <th title="Copy WS subscribe payload to clipboard"></th>
                </tr>
              </thead>
              <tbody>
                {results.map((item) => (
                  <tr key={item.id}>
                    <td style={{ fontWeight: 600 }}>{item.symbol}</td>
                    <td className="cell-muted" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.name || '—'}
                    </td>
                    <td><Badge label={item.exchange} /></td>
                    <td><ProviderBadge provider={item.streamProvider} internalName={item._internalProvider} /></td>
                    <td><Badge label={item.segment} /></td>
                    <td><Badge label={item.instrumentType} /></td>
                    <td className="cell-muted">{item.expiry ? item.expiry.substring(0, 10) : '—'}</td>
                    <td className="cell-num">{item.strike ? fmt(item.strike, 0) : '—'}</td>
                    <td className="cell-num"><LtpCell value={item.last_price} priceStatus={item.priceStatus} /></td>
                    <td className="cell-num cell-muted">{item.lotSize ?? '—'}</td>
                    <td className="cell-num cell-muted" style={{ fontSize: 9 }}>{item.id}</td>
                    <td><CopyWsPayloadButton uirId={item.id} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
