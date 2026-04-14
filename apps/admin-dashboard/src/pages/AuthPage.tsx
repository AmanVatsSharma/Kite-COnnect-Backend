/**
 * @file AuthPage.tsx
 * @module admin-dashboard
 * @description Provider authentication — Kite OAuth popup + Vortex callback form.
 * @author BharatERP
 * @updated 2026-04-14
 */

import { useState } from 'react';
import { apiFetch } from '../lib/api-client';
import { apiUrl } from '../lib/api-base';

export function AuthPage() {
  const [vortexAuth, setVortexAuth] = useState('');
  const [kiteLoading, setKiteLoading] = useState(false);
  const [vortexLoading, setVortexLoading] = useState(false);
  const [kiteMsg, setKiteMsg] = useState<string | null>(null);
  const [vortexMsg, setVortexMsg] = useState<string | null>(null);
  const [kiteOk, setKiteOk] = useState(false);
  const [vortexOk, setVortexOk] = useState(false);

  async function startKite() {
    setKiteMsg(null);
    setKiteLoading(true);
    try {
      const data = await apiFetch<{ url?: string }>('/api/auth/kite/login');
      if (data?.url) {
        window.open(data.url, 'kite-auth', 'width=600,height=700');
        setKiteOk(true);
        setKiteMsg('OAuth popup opened');
      } else {
        setKiteMsg('No redirect URL in response');
        setKiteOk(false);
      }
    } catch (e) {
      setKiteMsg((e as Error).message);
      setKiteOk(false);
    } finally {
      setKiteLoading(false);
    }
  }

  async function completeVortex() {
    setVortexMsg(null);
    if (!vortexAuth.trim()) { setVortexMsg('Paste auth parameter first'); return; }
    setVortexLoading(true);
    try {
      const q = new URLSearchParams({ auth: vortexAuth.trim() });
      const data = await apiFetch<{ success?: boolean }>(`/api/auth/vortex/callback?${q}`);
      setVortexMsg(data && typeof data === 'object' ? JSON.stringify(data) : 'OK');
      setVortexOk(true);
    } catch (e) {
      setVortexMsg((e as Error).message);
      setVortexOk(false);
    } finally {
      setVortexLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div className="page-head">
        <h1>PROVIDER AUTHENTICATION</h1>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>
          OAuth + callback flows against the same API origin
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {/* ── Kite OAuth ─────────────────────────────────────── */}
        <div className="panel">
          <div className="panel__head">
            <span className="panel__title">FALCON (KITE) OAUTH</span>
            {kiteOk && <span className="cc-chip cc-chip--ok" style={{ fontSize: 9 }}>POPUP OPENED</span>}
          </div>
          <div className="panel__body">
            <p style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.6 }}>
              Opens Kite Connect OAuth in a popup window. After user approval, Kite redirects to the
              callback URL which automatically saves the access token to the database.
            </p>

            <div className="panel-section-title" style={{ marginBottom: 6 }}>STEP 1 — INITIATE</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <button
                type="button"
                className="btn-xs btn-xs--ok"
                onClick={() => void startKite()}
                disabled={kiteLoading}
              >
                {kiteLoading ? 'Opening…' : '▶ Start Kite OAuth (popup)'}
              </button>
              <a
                href={apiUrl('/api/auth/kite/login')}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 10, color: 'var(--accent)', textDecoration: 'none' }}
              >
                ↗ Open directly
              </a>
            </div>

            {kiteMsg && (
              <div style={{
                fontSize: 10,
                color: kiteOk ? 'var(--ok)' : 'var(--bad)',
                padding: '5px 8px',
                background: kiteOk ? 'rgba(43,211,155,0.06)' : 'rgba(255,107,107,0.06)',
                border: `1px solid ${kiteOk ? 'rgba(43,211,155,0.15)' : 'rgba(255,107,107,0.15)'}`,
                borderRadius: 4,
              }}>
                {kiteMsg}
              </div>
            )}
          </div>
        </div>

        {/* ── Vortex auth ────────────────────────────────────── */}
        <div className="panel">
          <div className="panel__head">
            <span className="panel__title">VAYU (VORTEX) AUTH</span>
            {vortexOk && <span className="cc-chip cc-chip--ok" style={{ fontSize: 9 }}>AUTH COMPLETE</span>}
          </div>
          <div className="panel__body">
            <p style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.6 }}>
              1. Open Vortex login &nbsp;→&nbsp; 2. Approve access &nbsp;→&nbsp; 3. Copy the{' '}
              <code style={{ fontSize: 10 }}>auth</code> query param from the callback URL &nbsp;→&nbsp; 4. Paste &amp; submit.
            </p>

            <div className="panel-section-title" style={{ marginBottom: 6 }}>STEP 1 — OPEN LOGIN</div>
            <div style={{ marginBottom: 10 }}>
              <a
                href={apiUrl('/api/auth/vortex/login')}
                target="_blank"
                rel="noreferrer"
                className="btn-xs"
                style={{ textDecoration: 'none', display: 'inline-block' }}
              >
                ↗ Open Vortex Login
              </a>
            </div>

            <div className="panel-section-title" style={{ marginBottom: 4 }}>STEP 2 — PASTE AUTH PARAM</div>
            <textarea
              value={vortexAuth}
              onChange={(e) => setVortexAuth(e.target.value)}
              placeholder="Paste auth=... value from callback URL"
              rows={3}
              style={{
                width: '100%',
                fontSize: 11,
                padding: '4px 6px',
                marginBottom: 8,
                background: 'var(--bg)',
                border: '1px solid var(--panel-border)',
                color: 'var(--text)',
                borderRadius: 4,
                resize: 'vertical',
                fontFamily: 'ui-monospace, monospace',
              }}
            />
            <button
              type="button"
              className="btn-xs btn-xs--ok"
              onClick={() => void completeVortex()}
              disabled={vortexLoading || !vortexAuth.trim()}
            >
              {vortexLoading ? 'Submitting…' : 'Complete Vortex Auth'}
            </button>

            {vortexMsg && (
              <div style={{
                marginTop: 8,
                fontSize: 10,
                color: vortexOk ? 'var(--ok)' : 'var(--bad)',
                padding: '5px 8px',
                background: vortexOk ? 'rgba(43,211,155,0.06)' : 'rgba(255,107,107,0.06)',
                border: `1px solid ${vortexOk ? 'rgba(43,211,155,0.15)' : 'rgba(255,107,107,0.15)'}`,
                borderRadius: 4,
                fontFamily: 'ui-monospace, monospace',
                wordBreak: 'break-all',
              }}>
                {vortexMsg}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
