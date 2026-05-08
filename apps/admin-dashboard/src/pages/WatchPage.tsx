/**
 * @file WatchPage.tsx
 * @module admin-dashboard
 * @description Real-time WebSocket watch page: monitor granular connections, origins, and top instruments.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import { ErrorInline } from '../components/ErrorInline';

export function WatchPage() {
  const token = getAdminToken();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');

  const watch = useQuery({
    queryKey: ['admin-ws-watch'],
    queryFn: admin.getWsWatch,
    enabled: !!token,
    refetchInterval: 3000,
  });

  const disconnect = useMutation({
    mutationFn: admin.disconnectSocket,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-ws-watch'] });
    },
  });

  const blockKey = useMutation({
    mutationFn: admin.manualBlockAbuse,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-ws-watch'] });
    },
  });

  const filteredSockets = useMemo(() => {
    if (!watch.data?.sockets) return [];
    const s = search.toLowerCase();
    return watch.data.sockets.filter(
      (sock) =>
        sock.socketId.toLowerCase().includes(s) ||
        sock.apiKey.toLowerCase().includes(s) ||
        (sock.origin || '').toLowerCase().includes(s) ||
        (sock.ip || '').toLowerCase().includes(s)
    );
  }, [watch.data?.sockets, search]);

  if (!token) {
    return (
      <section className="card">
        <p className="err">Add an admin token in Settings.</p>
      </section>
    );
  }

  function trunc(s: string | null, len = 25) {
    if (!s) return '—';
    return s.length > len ? s.slice(0, len) + '…' : s;
  }

  function fmtDate(d: string | null) {
    if (!d) return '—';
    return new Date(d).toLocaleTimeString();
  }

  return (
    <div className="watch-page">
      {/* --- Top Stats --- */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div className="card stat-card">
          <div className="stat-card__label">LIVE CONNECTIONS</div>
          <div className="stat-card__value" style={{ color: 'var(--ok)' }}>
            {watch.data?.totalConnections ?? '—'}
          </div>
        </div>
        <div className="card stat-card">
          <div className="stat-card__label">ACTIVE INSTRUMENTS</div>
          <div className="stat-card__value" style={{ color: 'var(--accent)' }}>
            {watch.data?.topInstruments?.length ?? '—'}
          </div>
        </div>
        <div className="card stat-card">
          <div className="stat-card__label">LAST UPDATED</div>
          <div className="stat-card__value" style={{ fontSize: 14 }}>
            {watch.data?.timestamp ? new Date(watch.data.timestamp).toLocaleTimeString() : '—'}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        {/* --- Sockets Table --- */}
        <section className="panel">
          <div className="panel__head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="panel__title">GRANULAR CONNECTIONS</span>
            <input
              placeholder="Filter by key, socket, origin..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ fontSize: 11, padding: '4px 8px', width: 250 }}
            />
          </div>
          <div className="panel__body" style={{ padding: 0 }}>
            <ErrorInline message={watch.isError ? (watch.error as Error).message : null} />
            <div className="scroll-x">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>SOCKET ID</th>
                    <th>API KEY</th>
                    <th>ORIGIN / HOST</th>
                    <th>IP</th>
                    <th className="cell-num">SUBS</th>
                    <th>CONNECTED</th>
                    <th>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSockets.length > 0 ? (
                    filteredSockets.map((s) => (
                      <tr key={s.socketId}>
                        <td className="cell-code" title={s.socketId}>{s.socketId.slice(0, 8)}…</td>
                        <td className="cell-key" title={s.apiKey}>{trunc(s.apiKey, 12)}</td>
                        <td className="cell-muted" title={s.origin || ''} style={{ fontSize: 10 }}>
                          {trunc(s.origin, 30)}
                        </td>
                        <td className="cell-muted" style={{ fontSize: 10 }}>{s.ip || '—'}</td>
                        <td className="cell-num" style={{ fontWeight: 700 }}>{s.instruments}</td>
                        <td className="cell-muted" style={{ fontSize: 10 }}>{fmtDate(s.connectedAt)}</td>
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              className="btn-xs btn-xs--danger"
                              title="Kill Socket"
                              onClick={() => {
                                if (confirm(`Disconnect socket ${s.socketId}?`)) {
                                  disconnect.mutate(s.socketId);
                                }
                              }}
                              disabled={disconnect.isPending}
                            >
                              KILL
                            </button>
                            <button
                              className="btn-xs"
                              title="Block API Key"
                              style={{ background: 'var(--bad)', color: '#fff' }}
                              onClick={() => {
                                if (confirm(`BLOCK API KEY ${s.apiKey} for all future connections?`)) {
                                  blockKey.mutate({ api_key: s.apiKey, reason: 'Manual block from Watch page' });
                                }
                              }}
                              disabled={blockKey.isPending}
                            >
                              BLOCK
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>
                        {watch.isLoading ? 'Loading connections...' : 'No active connections found'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* --- Top Instruments --- */}
        <section className="panel">
          <div className="panel__head">
            <span className="panel__title">MOST FETCHED INSTRUMENTS</span>
          </div>
          <div className="panel__body" style={{ padding: 0 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>SYMBOL</th>
                  <th className="cell-num">SUBS</th>
                  <th className="cell-num">TOKEN</th>
                </tr>
              </thead>
              <tbody>
                {watch.data?.topInstruments?.map((inst) => (
                  <tr key={inst.token}>
                    <td style={{ fontWeight: 600, fontSize: 11 }}>{inst.symbol || 'Unknown'}</td>
                    <td className="cell-num">
                      <span className="badge badge--ok">{inst.subscribers}</span>
                    </td>
                    <td className="cell-num cell-muted" style={{ fontSize: 10 }}>{inst.token}</td>
                  </tr>
                ))}
                {(!watch.data?.topInstruments || watch.data.topInstruments.length === 0) && (
                  <tr>
                    <td colSpan={3} style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>
                      No subscription data
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <style>{`
        .watch-page {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .stat-card {
          padding: 16px;
          text-align: center;
        }
        .stat-card__label {
          font-size: 10px;
          color: var(--muted);
          margin-bottom: 4px;
          font-weight: 700;
          letter-spacing: 0.05em;
        }
        .stat-card__value {
          font-size: 24px;
          font-weight: 800;
        }
        .scroll-x {
          overflow-x: auto;
        }
        .badge {
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 700;
        }
        .badge--ok {
          background: rgba(43,211,155,0.15);
          color: var(--ok);
        }
      `}</style>
    </div>
  );
}
