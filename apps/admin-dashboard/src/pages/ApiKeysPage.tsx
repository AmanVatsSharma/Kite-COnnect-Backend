import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import type { ApiKeyRow } from '../lib/types';
import { JsonBlock } from '../components/JsonBlock';

export function ApiKeysPage() {
  const token = getAdminToken();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [nk, setNk] = useState({ key: '', tenant_id: 'default', rate_limit_per_minute: 600, connection_limit: 2000 });
  const [limitKey, setLimitKey] = useState('');
  const [limitBody, setLimitBody] = useState('{"rate_limit_per_minute":600}');
  const [provKey, setProvKey] = useState('');
  const [prov, setProv] = useState<'kite' | 'vortex' | 'inherit'>('inherit');
  const [detailKey, setDetailKey] = useState('');

  const keys = useQuery({ queryKey: ['admin-apikeys'], queryFn: admin.listApiKeys, enabled: !!token });
  const usage = useQuery({
    queryKey: ['admin-apikeys-usage', page],
    queryFn: () => admin.listApiKeysUsage(page, 25),
    enabled: !!token,
    refetchInterval: 15000,
  });

  const create = useMutation({
    mutationFn: admin.createApiKey,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-apikeys'] }),
  });
  const deactivate = useMutation({
    mutationFn: admin.deactivateApiKey,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-apikeys'] }),
  });
  const patchLimits = useMutation({
    mutationFn: (b: Parameters<typeof admin.updateApiKeyLimits>[0]) => admin.updateApiKeyLimits(b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-apikeys'] }),
  });
  const setProvider = useMutation({
    mutationFn: admin.setApiKeyProvider,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-apikeys'] }),
  });

  const limitsDetail = useQuery({
    queryKey: ['admin-key-limits', detailKey],
    queryFn: () => admin.getApiKeyLimits(detailKey),
    enabled: !!token && detailKey.length > 0,
  });
  const usageDetail = useQuery({
    queryKey: ['admin-key-usage', detailKey],
    queryFn: () => admin.getApiKeyUsage(detailKey),
    enabled: !!token && detailKey.length > 0,
  });
  const usageReportQ = useQuery({
    queryKey: ['admin-usage-report', detailKey],
    queryFn: () => admin.getUsageReport(detailKey),
    enabled: !!token && detailKey.length > 0,
  });

  if (!token) {
    return (
      <section className="card">
        <p className="err">Add an admin token in Settings.</p>
      </section>
    );
  }

  function submitLimits() {
    let extra: Record<string, unknown>;
    try {
      extra = JSON.parse(limitBody) as Record<string, unknown>;
    } catch {
      alert('Limits JSON invalid');
      return;
    }
    patchLimits.mutate({ key: limitKey, ...extra } as Parameters<typeof admin.updateApiKeyLimits>[0]);
  }

  return (
    <>
      <section className="card">
        <h2>Create API key</h2>
        <div className="row">
          <div>
            <label>Key</label>
            <input value={nk.key} onChange={(e) => setNk({ ...nk, key: e.target.value })} />
          </div>
          <div>
            <label>Tenant</label>
            <input value={nk.tenant_id} onChange={(e) => setNk({ ...nk, tenant_id: e.target.value })} />
          </div>
        </div>
        <div className="row">
          <div>
            <label>HTTP rate / min</label>
            <input
              type="number"
              value={nk.rate_limit_per_minute}
              onChange={(e) => setNk({ ...nk, rate_limit_per_minute: Number(e.target.value) })}
            />
          </div>
          <div>
            <label>Connection limit</label>
            <input
              type="number"
              value={nk.connection_limit}
              onChange={(e) => setNk({ ...nk, connection_limit: Number(e.target.value) })}
            />
          </div>
        </div>
        <button type="button" className="btn" disabled={create.isPending || !nk.key} onClick={() => create.mutate(nk)}>
          Create
        </button>
        {create.isError && <p className="err">{(create.error as Error).message}</p>}
      </section>

      <section className="card">
        <h2>Update limits (JSON merge)</h2>
        <p className="muted">Required: key. Optional: rate_limit_per_minute, connection_limit, ws_*_rps, allowed_exchanges.</p>
        <div className="row">
          <div>
            <label>Key id</label>
            <input value={limitKey} onChange={(e) => setLimitKey(e.target.value)} placeholder="demo-key-1" />
          </div>
        </div>
        <label>JSON</label>
        <textarea value={limitBody} onChange={(e) => setLimitBody(e.target.value)} />
        <button type="button" className="btn" disabled={patchLimits.isPending || !limitKey} onClick={submitLimits}>
          Apply limits
        </button>
        {patchLimits.isError && <p className="err">{(patchLimits.error as Error).message}</p>}
      </section>

      <section className="card">
        <h2>Per-key provider override</h2>
        <div className="row">
          <div>
            <label>Key</label>
            <input value={provKey} onChange={(e) => setProvKey(e.target.value)} />
          </div>
          <div>
            <label>Provider</label>
            <select value={prov} onChange={(e) => setProv(e.target.value as typeof prov)}>
              <option value="inherit">inherit (null)</option>
              <option value="kite">kite</option>
              <option value="vortex">vortex</option>
            </select>
          </div>
        </div>
        <button
          type="button"
          className="btn"
          disabled={setProvider.isPending || !provKey}
          onClick={() => setProvider.mutate({ key: provKey, provider: prov === 'inherit' ? null : prov })}
        >
          Save provider
        </button>
      </section>

      <section className="card">
        <h2>All keys</h2>
        {keys.isError && <p className="err">{(keys.error as Error).message}</p>}
        {keys.data && (
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Tenant</th>
                <th>Active</th>
                <th>Provider</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k: ApiKeyRow) => (
                <tr key={k.key}>
                  <td>
                    <code>{k.key}</code>
                  </td>
                  <td>{k.tenant_id}</td>
                  <td>{k.is_active ? 'yes' : 'no'}</td>
                  <td>{k.provider ?? '-'}</td>
                  <td>
                    <button
                      type="button"
                      className={detailKey === k.key ? 'btn' : 'btn btn-ghost'}
                      style={{ marginRight: 6 }}
                      onClick={() => setDetailKey(k.key)}
                    >
                      Inspect
                    </button>
                    {k.is_active && (
                      <button type="button" className="btn btn-danger btn-ghost" onClick={() => deactivate.mutate(k.key)}>
                        Deactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {detailKey && (
        <section className="card">
          <h2>Key detail: {detailKey}</h2>
          <button type="button" className="btn btn-ghost" style={{ marginBottom: 12 }} onClick={() => setDetailKey('')}>
            Clear selection
          </button>
          <h3 className="muted">GET …/apikeys/:key/limits</h3>
          {limitsDetail.isError && <p className="err">{(limitsDetail.error as Error).message}</p>}
          {limitsDetail.data && <JsonBlock value={limitsDetail.data} />}
          <h3 className="muted" style={{ marginTop: 16 }}>
            GET …/apikeys/:key/usage
          </h3>
          {usageDetail.isError && <p className="err">{(usageDetail.error as Error).message}</p>}
          {usageDetail.data && <JsonBlock value={usageDetail.data} />}
          <h3 className="muted" style={{ marginTop: 16 }}>
            GET …/usage?key= (legacy query)
          </h3>
          {usageReportQ.isError && <p className="err">{(usageReportQ.error as Error).message}</p>}
          {usageReportQ.data && <JsonBlock value={usageReportQ.data} />}
        </section>
      )}

      <section className="card">
        <h2>Usage (paginated)</h2>
        <div className="row">
          <button type="button" className="btn btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Prev
          </button>
          <span className="muted" style={{ alignSelf: 'center' }}>
            Page {usage.data?.page ?? page} / {usage.data ? Math.ceil(usage.data.total / usage.data.pageSize) : '?'}
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!usage.data || page * usage.data.pageSize >= usage.data.total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
        {usage.isError && <p className="err">{(usage.error as Error).message}</p>}
        {usage.data && <JsonBlock value={usage.data} />}
      </section>
    </>
  );
}
