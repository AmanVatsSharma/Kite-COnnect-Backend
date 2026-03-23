import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import { JsonBlock } from '../components/JsonBlock';

export function WsAdminPage() {
  const token = getAdminToken();
  const qc = useQueryClient();
  const [subRps, setSubRps] = useState('');
  const [unsubRps, setUnsubRps] = useState('');
  const [modeRps, setModeRps] = useState('');
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
    refetchInterval: 4000,
  });

  const config = useQuery({
    queryKey: ['admin-ws-config'],
    queryFn: admin.getWsConfig,
    enabled: !!token,
  });

  const setRps = useMutation({
    mutationFn: admin.setWsRateLimits,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-ws-config'] }),
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

  return (
    <>
      <section className="card">
        <h2>WS status</h2>
        {status.isError && <p className="err">{(status.error as Error).message}</p>}
        {status.data && <JsonBlock value={status.data} />}
      </section>

      <section className="card">
        <h2>WS config</h2>
        {config.data && <JsonBlock value={config.data} />}
        <h3 style={{ marginTop: 16 }}>Update process env rate limits</h3>
        <div className="row">
          <div>
            <label>subscribe_rps</label>
            <input value={subRps} onChange={(e) => setSubRps(e.target.value)} placeholder="10" />
          </div>
          <div>
            <label>unsubscribe_rps</label>
            <input value={unsubRps} onChange={(e) => setUnsubRps(e.target.value)} />
          </div>
          <div>
            <label>mode_rps</label>
            <input value={modeRps} onChange={(e) => setModeRps(e.target.value)} />
          </div>
        </div>
        <button
          type="button"
          className="btn"
          disabled={setRps.isPending}
          onClick={() =>
            setRps.mutate({
              subscribe_rps: subRps ? Number(subRps) : undefined,
              unsubscribe_rps: unsubRps ? Number(unsubRps) : undefined,
              mode_rps: modeRps ? Number(modeRps) : undefined,
            })
          }
        >
          Apply rate limits
        </button>
      </section>

      <section className="card">
        <h2>Entitlements</h2>
        <div className="row">
          <div>
            <label>API key</label>
            <input value={entKey} onChange={(e) => setEntKey(e.target.value)} />
          </div>
          <div>
            <label>Exchanges (comma)</label>
            <input value={entEx} onChange={(e) => setEntEx(e.target.value)} />
          </div>
        </div>
        <button
          type="button"
          className="btn"
          disabled={ent.isPending || !entKey}
          onClick={() =>
            ent.mutate({
              apiKey: entKey,
              exchanges: entEx
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        >
          Save entitlements
        </button>
      </section>

      <section className="card">
        <h2>Blocklist (JSON body)</h2>
        <p className="muted">Optional: tokens[], exchanges[], apiKey, tenant_id, reason</p>
        <textarea value={blJson} onChange={(e) => setBlJson(e.target.value)} />
        <button
          type="button"
          className="btn"
          disabled={block.isPending}
          onClick={() => {
            try {
              block.mutate(JSON.parse(blJson));
            } catch {
              alert('Invalid JSON');
            }
          }}
        >
          Add blocklist entries
        </button>
      </section>

      <section className="card">
        <h2>Flush caches</h2>
        <input value={flushCaches} onChange={(e) => setFlushCaches(e.target.value)} />
        <button
          type="button"
          className="btn"
          style={{ marginLeft: 8 }}
          disabled={flush.isPending}
          onClick={() =>
            flush.mutate(
              flushCaches
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
        >
          Flush
        </button>
      </section>

      <section className="card">
        <h2>Namespace broadcast</h2>
        <div className="row">
          <div>
            <label>event</label>
            <input value={bcEvent} onChange={(e) => setBcEvent(e.target.value)} />
          </div>
          <div>
            <label>room (optional)</label>
            <input value={bcRoom} onChange={(e) => setBcRoom(e.target.value)} />
          </div>
        </div>
        <label>payload (JSON)</label>
        <textarea value={bcPayload} onChange={(e) => setBcPayload(e.target.value)} />
        <button
          type="button"
          className="btn"
          disabled={broadcast.isPending}
          onClick={() => {
            try {
              broadcast.mutate({
                event: bcEvent,
                room: bcRoom || undefined,
                payload: JSON.parse(bcPayload) as object,
              });
            } catch {
              alert('Invalid payload JSON');
            }
          }}
        >
          Broadcast
        </button>
        {broadcast.data && <JsonBlock value={broadcast.data} />}
      </section>
    </>
  );
}
