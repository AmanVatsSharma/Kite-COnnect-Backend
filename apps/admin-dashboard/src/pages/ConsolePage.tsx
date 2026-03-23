import { useState } from 'react';
import { apiRequestRaw } from '../lib/api-client';
import { JsonBlock } from '../components/JsonBlock';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export function ConsolePage() {
  const [method, setMethod] = useState<(typeof METHODS)[number]>('GET');
  const [path, setPath] = useState('/api/admin/ws/status');
  const [body, setBody] = useState('{}');
  const [sendAdmin, setSendAdmin] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ status: number; ok: boolean; data: unknown } | null>(null);
  const [rawCopy, setRawCopy] = useState('');

  async function send() {
    setLoading(true);
    setResult(null);
    try {
      let parsedBody: string | undefined;
      if (method !== 'GET' && method !== 'DELETE' && body.trim()) {
        JSON.parse(body);
        parsedBody = body;
      }
      const r = await apiRequestRaw(path.startsWith('/') ? path : `/${path}`, {
        method,
        body: parsedBody,
        admin: sendAdmin,
        apiKey: apiKey.trim() || null,
      });
      setRawCopy(typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2));
      setResult({ status: r.status, ok: r.ok, data: r.data });
    } catch (e) {
      setResult({
        status: 0,
        ok: false,
        data: { error: (e as Error).message },
      });
      setRawCopy((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card">
      <h2>Admin API console</h2>
      <p className="muted">
        Call any path on this API origin. Use for endpoints not covered by curated pages. Prefer paths under{' '}
        <code>/api/admin/...</code>.
      </p>
      <div className="row">
        <div style={{ minWidth: 100, maxWidth: 140 }}>
          <label htmlFor="m">Method</label>
          <select id="m" value={method} onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 2 }}>
          <label htmlFor="p">Path</label>
          <input id="p" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/api/admin/..." />
        </div>
      </div>
      {(method === 'POST' || method === 'PUT' || method === 'PATCH') && (
        <>
          <label htmlFor="b">JSON body</label>
          <textarea id="b" value={body} onChange={(e) => setBody(e.target.value)} />
        </>
      )}
      <div className="row" style={{ alignItems: 'center' }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={sendAdmin} onChange={(e) => setSendAdmin(e.target.checked)} />
          Send x-admin-token
        </label>
      </div>
      <div className="row">
        <div>
          <label htmlFor="apk">Optional x-api-key</label>
          <input id="apk" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="for non-admin routes" />
        </div>
      </div>
      <button type="button" className="btn" disabled={loading || !path.trim()} onClick={() => void send()}>
        {loading ? 'Sending…' : 'Send'}
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        style={{ marginLeft: 8 }}
        disabled={!rawCopy}
        onClick={() => void navigator.clipboard.writeText(rawCopy)}
      >
        Copy response
      </button>
      {result && (
        <div style={{ marginTop: 16 }}>
          <p className="muted">
            HTTP {result.status} {result.ok ? 'OK' : '(error)'}
          </p>
          <JsonBlock value={result.data} />
        </div>
      )}
    </section>
  );
}
