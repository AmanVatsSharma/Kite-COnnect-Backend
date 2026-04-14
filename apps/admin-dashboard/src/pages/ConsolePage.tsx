/**
 * @file ConsolePage.tsx
 * @module admin-dashboard
 * @description Full-height API console — inline request bar, JSON body, scrollable response pane.
 * @author BharatERP
 * @updated 2026-04-14
 */

import { useState } from 'react';
import { apiRequestRaw } from '../lib/api-client';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const METHOD_COLOR: Record<string, string> = {
  GET: 'var(--ok)',
  POST: 'var(--accent)',
  PUT: 'var(--warn)',
  PATCH: 'var(--warn)',
  DELETE: 'var(--bad)',
};

export function ConsolePage() {
  const [method, setMethod] = useState<(typeof METHODS)[number]>('GET');
  const [path, setPath] = useState('/api/admin/ws/status');
  const [body, setBody] = useState('{}');
  const [sendAdmin, setSendAdmin] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ status: number; ok: boolean; data: unknown } | null>(null);
  const [rawCopy, setRawCopy] = useState('');

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH';

  async function send() {
    setLoading(true);
    setResult(null);
    try {
      let parsedBody: string | undefined;
      if (needsBody && body.trim()) {
        JSON.parse(body); // validate JSON
        parsedBody = body;
      }
      const r = await apiRequestRaw(path.startsWith('/') ? path : `/${path}`, {
        method,
        body: parsedBody,
        admin: sendAdmin,
        apiKey: apiKey.trim() || null,
      });
      const formatted = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2);
      setRawCopy(formatted);
      setResult({ status: r.status, ok: r.ok, data: r.data });
    } catch (e) {
      const msg = (e as Error).message;
      setResult({ status: 0, ok: false, data: { error: msg } });
      setRawCopy(msg);
    } finally {
      setLoading(false);
    }
  }

  const responseText = result ? JSON.stringify(result.data, null, 2) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div className="page-head">
        <h1>API CONSOLE</h1>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>
          Raw HTTP against this origin · admin + api-key auth
        </span>
      </div>

      {/* ── Request panel ──────────────────────────────────────── */}
      <div className="panel" style={{ flexShrink: 0 }}>
        <div className="panel__head">
          <span className="panel__title">REQUEST</span>
          {result && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10 }}>
              <span
                className="dot"
                style={{ background: result.ok ? 'var(--ok)' : 'var(--bad)' }}
              />
              <span style={{ color: result.ok ? 'var(--ok)' : 'var(--bad)', fontWeight: 700, fontFamily: 'ui-monospace,monospace' }}>
                HTTP {result.status || 'ERR'} {result.ok ? '✓' : '✗'}
              </span>
            </span>
          )}
        </div>
        <div className="panel__body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Method + path + send */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])}
              style={{
                fontSize: 11,
                padding: '4px 6px',
                fontWeight: 700,
                fontFamily: 'ui-monospace, monospace',
                color: METHOD_COLOR[method],
                background: 'var(--panel-bg)',
                border: '1px solid var(--panel-border)',
                borderRadius: 4,
                minWidth: 82,
              }}
            >
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !loading && void send()}
              placeholder="/api/admin/..."
              style={{ flex: 1, fontSize: 11, padding: '4px 8px', fontFamily: 'ui-monospace, monospace' }}
            />
            <button
              type="button"
              className="btn-xs btn-xs--ok"
              disabled={loading || !path.trim()}
              onClick={() => void send()}
              style={{ minWidth: 68 }}
            >
              {loading ? 'Sending…' : '▶ Send'}
            </button>
          </div>

          {/* Options row */}
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={sendAdmin} onChange={(e) => setSendAdmin(e.target.checked)} />
              <span style={{ color: sendAdmin ? 'var(--ok)' : 'var(--muted)' }}>x-admin-token</span>
            </label>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: 'var(--muted)' }}>x-api-key:</span>
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="optional"
                style={{ fontSize: 10, padding: '2px 6px', width: 160, fontFamily: 'ui-monospace, monospace' }}
              />
            </div>
            {rawCopy && (
              <button
                type="button"
                className="btn-xs"
                style={{ marginLeft: 'auto' }}
                onClick={() => void navigator.clipboard.writeText(rawCopy)}
              >
                Copy response
              </button>
            )}
          </div>

          {/* JSON body (only for POST/PUT/PATCH) */}
          {needsBody && (
            <div>
              <label style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 3, display: 'block' }}>
                JSON BODY
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                style={{
                  width: '100%',
                  fontSize: 11,
                  padding: '4px 6px',
                  fontFamily: 'ui-monospace, monospace',
                  background: '#090d13',
                  border: '1px solid var(--panel-border)',
                  color: 'var(--text)',
                  borderRadius: 4,
                  resize: 'vertical',
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* ── Response panel ─────────────────────────────────────── */}
      <div className="panel" style={{ flex: 1, minHeight: 0 }}>
        <div className="panel__head">
          <span className="panel__title">RESPONSE</span>
          {result && (
            <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'ui-monospace,monospace' }}>
              {typeof result.data === 'object' && result.data !== null
                ? `${JSON.stringify(result.data).length} bytes`
                : typeof result.data}
            </span>
          )}
        </div>
        <div className="panel__body" style={{ padding: 0 }}>
          {!result ? (
            <div style={{
              padding: '24px 12px',
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 11,
            }}>
              Send a request to see the response
            </div>
          ) : (
            <pre style={{
              margin: 0,
              padding: '10px 12px',
              fontSize: 11,
              fontFamily: 'ui-monospace, monospace',
              color: result.ok ? 'var(--text)' : 'var(--bad)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              lineHeight: 1.55,
            }}>
              {responseText}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
