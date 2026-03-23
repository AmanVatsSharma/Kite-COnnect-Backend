import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import type { AbuseFlag } from '../lib/types';

export function AbusePage() {
  const token = getAdminToken();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [blockedFilter, setBlockedFilter] = useState<boolean | undefined>(undefined);
  const [lookupKey, setLookupKey] = useState('');
  const [blockKey, setBlockKey] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const [unblockKey, setUnblockKey] = useState('');

  const list = useQuery({
    queryKey: ['admin-abuse', page, blockedFilter],
    queryFn: () => admin.listAbuseFlags(page, 40, blockedFilter),
    enabled: !!token,
    refetchInterval: 20000,
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
          <button type="button" className={`btn ${blockedFilter === undefined ? '' : 'btn-ghost'}`} onClick={() => { setBlockedFilter(undefined); setPage(1); }}>
            All
          </button>
          <button type="button" className={`btn ${blockedFilter === true ? '' : 'btn-ghost'}`} onClick={() => { setBlockedFilter(true); setPage(1); }}>
            Blocked only
          </button>
          <button type="button" className={`btn ${blockedFilter === false ? '' : 'btn-ghost'}`} onClick={() => { setBlockedFilter(false); setPage(1); }}>
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
        {list.isError && <p className="err">{(list.error as Error).message}</p>}
        {list.data && (
          <table>
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
                  <td>{f.risk_score}</td>
                  <td>{f.blocked ? 'yes' : 'no'}</td>
                  <td>{(f.reason_codes || []).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Lookup one key</h2>
        <input value={lookupKey} onChange={(e) => setLookupKey(e.target.value)} placeholder="api key id" />
        {one.isError && <p className="err">{(one.error as Error).message}</p>}
        {one.data && <pre className="json"><code>{JSON.stringify(one.data, null, 2)}</code></pre>}
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
        <button type="button" className="btn btn-danger" disabled={!blockKey || block.isPending} onClick={() => block.mutate({ api_key: blockKey, reason: blockReason || undefined })}>
          Block
        </button>
        <div className="row" style={{ marginTop: 16 }}>
          <div>
            <label>Unblock key</label>
            <input value={unblockKey} onChange={(e) => setUnblockKey(e.target.value)} />
          </div>
        </div>
        <button type="button" className="btn" disabled={!unblockKey || unblock.isPending} onClick={() => unblock.mutate({ api_key: unblockKey })}>
          Unblock
        </button>
      </section>
    </>
  );
}
