/**
 * @file AbusePage.tsx
 * @module admin-dashboard
 * @description Abuse flags list, lookup, and manual block with badges and structured detail.
 * @author BharatERP
 * @updated 2026-03-28
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import type { AbuseFlag } from '../lib/types';
import { ErrorInline } from '../components/ErrorInline';
import { KeyValueGrid } from '../components/KeyValueGrid';
import { RawJsonDetails } from '../components/RawJsonDetails';
import { StatusBadge } from '../components/StatusBadge';
import { abuseFlagFromUnknown, abuseRiskVariant } from '../lib/views/abuse-views';
import { useRefreshInterval } from '../hooks/useRefreshInterval';

export function AbusePage() {
  const token = getAdminToken();
  const qc = useQueryClient();
  const { refetchInterval, recordFetchLatency } = useRefreshInterval();
  const [page, setPage] = useState(1);
  const [blockedFilter, setBlockedFilter] = useState<boolean | undefined>(undefined);
  const [lookupKey, setLookupKey] = useState('');
  const [blockKey, setBlockKey] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const [unblockKey, setUnblockKey] = useState('');

  const fetchFlags = useCallback(async () => {
    const t0 = performance.now();
    try {
      return await admin.listAbuseFlags(page, 40, blockedFilter);
    } finally {
      recordFetchLatency(Math.round(performance.now() - t0));
    }
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

  return (
    <>
      <section className="card">
        <h2>Filters</h2>
        <div className="row">
          <button
            type="button"
            className={`btn ${blockedFilter === undefined ? '' : 'btn-ghost'}`}
            onClick={() => {
              setBlockedFilter(undefined);
              setPage(1);
            }}
          >
            All
          </button>
          <button
            type="button"
            className={`btn ${blockedFilter === true ? '' : 'btn-ghost'}`}
            onClick={() => {
              setBlockedFilter(true);
              setPage(1);
            }}
          >
            Blocked only
          </button>
          <button
            type="button"
            className={`btn ${blockedFilter === false ? '' : 'btn-ghost'}`}
            onClick={() => {
              setBlockedFilter(false);
              setPage(1);
            }}
          >
            Not blocked
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Flags</h2>
        <div className="row">
          <button type="button" className="btn btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Prev
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
        <ErrorInline message={list.isError ? (list.error as Error).message : null} />
        {list.data && (
          <table className="terminal-table">
            <thead>
              <tr>
                <th>API key</th>
                <th>Risk</th>
                <th>Blocked</th>
                <th>Reasons</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((f: AbuseFlag) => (
                <tr key={f.api_key}>
                  <td>
                    <code>{f.api_key}</code>
                  </td>
                  <td>
                    <StatusBadge variant={abuseRiskVariant(f.risk_score)}>{f.risk_score}</StatusBadge>
                  </td>
                  <td>
                    <StatusBadge variant={f.blocked ? 'bad' : 'ok'}>{f.blocked ? 'Blocked' : 'Clear'}</StatusBadge>
                  </td>
                  <td>{(f.reason_codes || []).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Lookup one key</h2>
        <input value={lookupKey} onChange={(e) => setLookupKey(e.target.value)} placeholder="api key id" />
        <ErrorInline message={one.isError ? (one.error as Error).message : null} />
        {one.data && (
          <>
            <KeyValueGrid rows={abuseFlagFromUnknown(one.data).map((r) => ({ label: r.label, value: r.value }))} />
            <RawJsonDetails value={one.data} summary="Technical details (raw JSON)" />
          </>
        )}
      </section>

      <section className="card">
        <h2>Manual block / unblock</h2>
        <div className="row">
          <div>
            <label>Block key</label>
            <input value={blockKey} onChange={(e) => setBlockKey(e.target.value)} />
          </div>
          <div>
            <label>Reason (optional)</label>
            <input value={blockReason} onChange={(e) => setBlockReason(e.target.value)} />
          </div>
        </div>
        <button
          type="button"
          className="btn btn-danger"
          disabled={!blockKey || block.isPending}
          onClick={() => block.mutate({ api_key: blockKey, reason: blockReason || undefined })}
        >
          Block
        </button>
        <div className="row" style={{ marginTop: 16 }}>
          <div>
            <label>Unblock key</label>
            <input value={unblockKey} onChange={(e) => setUnblockKey(e.target.value)} />
          </div>
        </div>
        <button
          type="button"
          className="btn"
          disabled={!unblockKey || unblock.isPending}
          onClick={() => unblock.mutate({ api_key: unblockKey })}
        >
          Unblock
        </button>
      </section>
    </>
  );
}
