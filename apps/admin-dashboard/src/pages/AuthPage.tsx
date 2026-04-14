/**
 * @file AuthPage.tsx
 * @module admin-dashboard
 * @description Provider authentication — Kite OAuth wizard (session card + 3-step stepper + manual fallback) + Vortex callback form.
 * @author BharatERP
 * @updated 2026-04-14 — Phase 3: full Kite auth wizard with session health card
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, getAdminToken } from '../lib/api-client';
import { apiUrl } from '../lib/api-base';
import {
  getFalconSession,
  getFalconProfile,
  revokeFalconSession,
  exchangeKiteRequestToken,
} from '../lib/falcon-api';
import { notify } from '../lib/toast';

// ─── Session Status Card ────────────────────────────────────────────────────

function fmtAge(createdAtMs: number): string {
  const s = Math.floor((Date.now() - createdAtMs) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtTtl(sec: number): string {
  if (sec < 0) return 'expired / missing';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function SessionCard({ onRevokeSuccess }: { onRevokeSuccess: () => void }) {
  const qc = useQueryClient();

  const sessionQ = useQuery({
    queryKey: ['falcon-session'],
    queryFn: getFalconSession,
    refetchInterval: 30_000,
    enabled: !!getAdminToken(),
  });

  const [validating, setValidating] = useState(false);
  const revokeMut = useMutation({
    mutationFn: revokeFalconSession,
    onSuccess: () => {
      notify.ok('Kite session revoked');
      void qc.invalidateQueries({ queryKey: ['falcon-session'] });
      void qc.invalidateQueries({ queryKey: ['kite-session-pill'] });
      onRevokeSuccess();
    },
    onError: (e: Error) => notify.error(`Revoke failed: ${e.message}`),
  });

  async function handleValidate() {
    setValidating(true);
    try {
      await getFalconProfile();
      notify.ok('Kite session valid — profile fetched');
    } catch (e) {
      notify.error(`Session invalid: ${(e as Error).message}`);
    } finally {
      setValidating(false);
    }
  }

  const d = sessionQ.data;
  const ttl = d?.ttlSeconds ?? -2;
  const hasToken = d?.hasToken ?? false;

  let statusColor = 'var(--ok)';
  let statusLabel = 'Session active';
  let statusBg = 'rgba(43,211,155,0.06)';
  let statusBorder = 'rgba(43,211,155,0.2)';

  if (!hasToken || ttl < 0) {
    statusColor = 'var(--bad)';
    statusLabel = 'Session expired / missing — Login required';
    statusBg = 'rgba(255,107,107,0.06)';
    statusBorder = 'rgba(255,107,107,0.2)';
  } else if (ttl < 7200) {
    statusColor = 'var(--warn, #f5a623)';
    statusLabel = `Token expires in ${fmtTtl(ttl)} — Re-authenticate soon`;
    statusBg = 'rgba(245,166,35,0.06)';
    statusBorder = 'rgba(245,166,35,0.2)';
  } else {
    statusLabel = `Session active · Token age: ${d?.createdAt ? fmtAge(d.createdAt) : '?'} · Expires in: ${fmtTtl(ttl)}`;
  }

  return (
    <div className="panel" style={{ marginBottom: 8 }}>
      <div className="panel__head">
        <span className="panel__title">KITE SESSION STATUS</span>
        {sessionQ.isFetching && <span className="muted" style={{ fontSize: 9 }}>refreshing…</span>}
      </div>
      <div className="panel__body">
        <div style={{
          fontSize: 11,
          padding: '8px 12px',
          background: sessionQ.isLoading ? 'var(--panel-bg)' : statusBg,
          border: `1px solid ${sessionQ.isLoading ? 'var(--panel-border)' : statusBorder}`,
          borderRadius: 4,
          color: sessionQ.isLoading ? 'var(--muted)' : statusColor,
          marginBottom: 10,
          lineHeight: 1.7,
        }}>
          {sessionQ.isLoading ? 'Checking…' : statusLabel}
          {d?.maskedToken && (
            <span style={{ marginLeft: 10, color: 'var(--muted)', fontSize: 10 }}>
              [{d.maskedToken}]
            </span>
          )}
        </div>

        {d?.lastError && (
          <div style={{
            fontSize: 10,
            padding: '5px 8px',
            background: 'rgba(255,107,107,0.06)',
            border: '1px solid rgba(255,107,107,0.15)',
            borderRadius: 4,
            color: 'var(--bad)',
            marginBottom: 8,
            fontFamily: 'ui-monospace, monospace',
          }}>
            Last error: {d.lastError.message}
            {d.lastError.time && <span style={{ color: 'var(--muted)', marginLeft: 6 }}>{d.lastError.time}</span>}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn-xs"
            onClick={() => void handleValidate()}
            disabled={validating || !hasToken}
          >
            {validating ? 'Validating…' : '✓ Validate Now'}
          </button>
          <button
            type="button"
            className="btn-xs btn-xs--bad"
            onClick={() => revokeMut.mutate()}
            disabled={revokeMut.isPending || !hasToken}
          >
            {revokeMut.isPending ? 'Revoking…' : '✕ Revoke Session'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Kite OAuth Wizard ──────────────────────────────────────────────────────

type WizardStep = 1 | 2 | 3;

function KiteAuthWizard() {
  const qc = useQueryClient();
  const [step, setStep] = useState<WizardStep>(1);
  const [popupOpened, setPopupOpened] = useState(false);
  const [pollEnabled, setPollEnabled] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [requestToken, setRequestToken] = useState('');
  const [exchanging, setExchanging] = useState(false);
  const [kiteLoading, setKiteLoading] = useState(false);

  // Poll for token while on step 2
  useQuery({
    queryKey: ['kite-wizard-poll'],
    queryFn: getFalconSession,
    refetchInterval: 2_000,
    enabled: pollEnabled && step === 2,
    select: (data) => {
      if (data?.hasToken && data?.connected) {
        setPollEnabled(false);
        setStep(3);
        notify.ok('Kite authenticated successfully');
        void qc.invalidateQueries({ queryKey: ['falcon-session'] });
        void qc.invalidateQueries({ queryKey: ['kite-session-pill'] });
      }
      return data;
    },
  });

  async function handleOpenLogin() {
    setKiteLoading(true);
    try {
      const data = await apiFetch<{ url?: string }>('/api/auth/falcon/login');
      if (data?.url) {
        window.open(data.url, 'kite-auth', 'width=600,height=700');
        setPopupOpened(true);
        setStep(2);
        setPollEnabled(true);
      } else {
        notify.error('No redirect URL returned');
      }
    } catch (e) {
      notify.error(`Login error: ${(e as Error).message}`);
    } finally {
      setKiteLoading(false);
    }
  }

  async function handleExchangeToken() {
    if (!requestToken.trim()) { notify.warn('Paste a request_token first'); return; }
    setExchanging(true);
    try {
      await exchangeKiteRequestToken(requestToken.trim());
      notify.ok('Token exchanged — session active');
      setStep(3);
      setShowFallback(false);
      void qc.invalidateQueries({ queryKey: ['falcon-session'] });
      void qc.invalidateQueries({ queryKey: ['kite-session-pill'] });
    } catch (e) {
      notify.error(`Exchange failed: ${(e as Error).message}`);
    } finally {
      setExchanging(false);
    }
  }

  function resetWizard() {
    setStep(1);
    setPopupOpened(false);
    setPollEnabled(false);
    setShowFallback(false);
    setRequestToken('');
  }

  const steps: { n: WizardStep; label: string }[] = [
    { n: 1, label: 'Open Login' },
    { n: 2, label: 'Authorize on Kite' },
    { n: 3, label: 'Done' },
  ];

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">FALCON (KITE) AUTH WIZARD</span>
        {step === 3 && <span className="cc-chip cc-chip--ok" style={{ fontSize: 9 }}>AUTHENTICATED</span>}
      </div>
      <div className="panel__body">

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 16, fontSize: 10 }}>
          {steps.map(({ n, label }, i) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '4px 10px',
                borderRadius: 3,
                background: step === n ? 'var(--accent)' : step > n ? 'rgba(43,211,155,0.12)' : 'var(--panel-border)',
                color: step === n ? '#000' : step > n ? 'var(--ok)' : 'var(--muted)',
                fontWeight: step === n ? 700 : 400,
                fontSize: 10,
              }}>
                <span>{step > n ? '✓' : n}</span>
                <span>{label}</span>
              </div>
              {i < steps.length - 1 && (
                <span style={{ color: 'var(--muted)', margin: '0 4px' }}>→</span>
              )}
            </div>
          ))}
        </div>

        {/* Step 1 */}
        {step === 1 && (
          <div>
            <p style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.6 }}>
              Opens Kite Connect OAuth in a popup. After you approve, the token is saved automatically.
            </p>
            <button
              type="button"
              className="btn-xs btn-xs--ok"
              onClick={() => void handleOpenLogin()}
              disabled={kiteLoading}
            >
              {kiteLoading ? 'Opening…' : '▶ Open Kite Login'}
            </button>
          </div>
        )}

        {/* Step 2 */}
        {step === 2 && (
          <div>
            <p style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.6 }}>
              {popupOpened
                ? 'Popup opened. Authorize your Kite account — this step will complete automatically once done.'
                : 'Waiting for popup…'}
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: 'var(--ok)' }}>
                ● Polling for session (every 2s)…
              </span>
              <button type="button" className="btn-xs" onClick={resetWizard}>
                ← Restart
              </button>
            </div>
          </div>
        )}

        {/* Step 3 */}
        {step === 3 && (
          <div>
            <p style={{ fontSize: 11, color: 'var(--ok)', marginBottom: 12 }}>
              ✓ Authenticated successfully. The session status card above will reflect the new token.
            </p>
            <button type="button" className="btn-xs" onClick={resetWizard}>
              ↺ New Login
            </button>
          </div>
        )}

        {/* Manual fallback */}
        {step !== 3 && (
          <div style={{ marginTop: 16, borderTop: '1px solid var(--panel-border)', paddingTop: 12 }}>
            <button
              type="button"
              className="btn-xs btn-xs--ghost"
              onClick={() => setShowFallback((v) => !v)}
              style={{ fontSize: 10, color: 'var(--muted)' }}
            >
              {showFallback ? '▲ Hide' : '▼ Show'} manual fallback (popup blocked?)
            </button>

            {showFallback && (
              <div style={{ marginTop: 10 }}>
                <p style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.7 }}>
                  1. Open this URL in a browser tab:<br />
                  <a
                    href={apiUrl('/api/auth/falcon/login')}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--accent)', fontSize: 10 }}
                  >
                    {apiUrl('/api/auth/falcon/login')} ↗
                  </a>
                  <br />
                  2. Authorize your Kite account.<br />
                  3. Copy the <code style={{ fontSize: 10 }}>request_token=</code> value from the redirect URL.<br />
                  4. Paste it below and click Exchange.
                </p>
                <textarea
                  value={requestToken}
                  onChange={(e) => setRequestToken(e.target.value)}
                  placeholder="Paste request_token value here…"
                  rows={2}
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
                  onClick={() => void handleExchangeToken()}
                  disabled={exchanging || !requestToken.trim()}
                >
                  {exchanging ? 'Exchanging…' : 'Exchange Token'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Vortex Auth ────────────────────────────────────────────────────────────

function VortexAuth() {
  const [vortexAuth, setVortexAuth] = useState('');
  const [vortexLoading, setVortexLoading] = useState(false);
  const [vortexMsg, setVortexMsg] = useState<string | null>(null);
  const [vortexOk, setVortexOk] = useState(false);

  async function completeVortex() {
    setVortexMsg(null);
    if (!vortexAuth.trim()) { setVortexMsg('Paste auth parameter first'); return; }
    setVortexLoading(true);
    try {
      const q = new URLSearchParams({ auth: vortexAuth.trim() });
      const data = await apiFetch<{ success?: boolean }>(`/api/auth/vortex/callback?${q}`);
      setVortexMsg(data && typeof data === 'object' ? JSON.stringify(data) : 'OK');
      setVortexOk(true);
      notify.ok('Vortex auth complete');
    } catch (e) {
      setVortexMsg((e as Error).message);
      setVortexOk(false);
      notify.error(`Vortex auth failed: ${(e as Error).message}`);
    } finally {
      setVortexLoading(false);
    }
  }

  return (
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
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function AuthPage() {
  const [wizardKey, setWizardKey] = useState(0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div className="page-head">
        <h1>PROVIDER AUTHENTICATION</h1>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>
          Kite OAuth wizard · session health · Vortex callback
        </span>
      </div>

      {/* Session status card — always visible */}
      <SessionCard onRevokeSuccess={() => setWizardKey((k) => k + 1)} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <KiteAuthWizard key={wizardKey} />
        <VortexAuth />
      </div>
    </div>
  );
}
