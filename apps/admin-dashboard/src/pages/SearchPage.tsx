/**
 * @file apps/admin-dashboard/src/pages/SearchPage.tsx
 * @module admin-dashboard
 * @description Universal instrument search UI backed by the search-api microservice.
 *              Lets admins test and browse instrument search with live LTP prices.
 *
 * Exports:
 *   - SearchPage — React page component, mounted at /search in the admin dashboard
 *
 * Depends on:
 *   - search-api.ts — typed client for /api/search endpoints
 *
 * Side-effects:
 *   - GET /api/search on every debounced query input
 *
 * Key invariants:
 *   - Queries only fire when q.length >= 2
 *   - LTP column shows '—' when last_price is null (instrument not live or not mapped)
 *   - search-api is proxied via nginx at /api/search — same-origin, no auth token needed
 *
 * Author:      BharatERP
 * Last-updated: 2026-04-25
 */

import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchInstruments, type SearchResultItem, type SearchFilters } from '../lib/search-api';

const EXCHANGES = ['', 'NSE', 'BSE', 'MCX', 'BFO', 'NFO'];
const SEGMENTS = ['', 'EQ', 'FO', 'CUR', 'COM'];
const INSTRUMENT_TYPES = ['', 'EQ', 'FUT', 'CE', 'PE', 'ETF'];
const LIMITS = [10, 20, 50];

function fmt(n: number | undefined | null, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', { maximumFractionDigits: decimals });
}

function fmtRs(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return null as any;
  return `₹${fmt(n)}`;
}

function LtpCell({ value }: { value?: number | null }) {
  const formatted = fmtRs(value);
  if (!formatted) return <span className="cell-muted">—</span>;
  return <span style={{ color: 'var(--ok)', fontWeight: 600 }}>{formatted}</span>;
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
                  <th>SEGMENT</th>
                  <th>TYPE</th>
                  <th>EXPIRY</th>
                  <th className="cell-num">STRIKE</th>
                  <th className="cell-num">LTP</th>
                  <th className="cell-num">LOT</th>
                  <th className="cell-num">UID</th>
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
                    <td><Badge label={item.segment} /></td>
                    <td><Badge label={item.instrumentType} /></td>
                    <td className="cell-muted">{item.expiry ? item.expiry.substring(0, 10) : '—'}</td>
                    <td className="cell-num">{item.strike ? fmt(item.strike, 0) : '—'}</td>
                    <td className="cell-num"><LtpCell value={item.last_price} /></td>
                    <td className="cell-num cell-muted">{item.lotSize ?? '—'}</td>
                    <td className="cell-num cell-muted" style={{ fontSize: 9 }}>{item.id}</td>
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
