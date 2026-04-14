/**
 * @file ProviderPage.tsx
 * @module admin-dashboard
 * @description Provider ops: global WS provider selector, stream controls, Vayu credentials.
 * @author BharatERP
 * @updated 2026-04-14
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import { ErrorInline } from '../components/ErrorInline';
import { adminProviderLabel, streamSummaryRows } from '../lib/views/overview-views';
import { flattenObject } from '../lib/views/flatten';

function Dot({ variant }: { variant: 'ok' | 'warn' | 'bad' | 'off' }) {
  const cls = variant === 'ok' ? 'dot--live' : variant === 'warn' ? 'dot--warn' : variant === 'bad' ? 'dot--dead' : 'dot--off';
  return <span className={`dot ${cls}`} />;
}

function StatRow({ label, value, variant }: { label: string; value: React.ReactNode; variant?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="stat-row">
      <span className="stat-row__label">{label}</span>
      <span className={`stat-row__value${variant ? ` stat-row__value--${variant}` : ''}`}>{value}</span>
    </div>
  );
}

export function ProviderPage() {
  const token = getAdminToken();
  const qc = useQueryClient();

  const globalProv = useQuery({ queryKey: ['admin-global-provider'], queryFn: admin.getGlobalProvider, enabled: !!token });
  const stream = useQuery({ queryKey: ['admin-stream-status'], queryFn: admin.getStreamStatus, enabled: !!token });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vayuConfig = useQuery({ queryKey: ['vayu-config'], queryFn: (admin as any).getVayuConfig, enabled: !!token });

  const setProv = useMutation({
    mutationFn: (provider: 'kite' | 'vortex') => admin.setGlobalProvider(provider),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-global-provider'] });
      void qc.invalidateQueries({ queryKey: ['admin-stream-status'] });
    },
  });
  const start = useMutation({ mutationFn: admin.startStream, onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-stream-status'] }) });
  const stop  = useMutation({ mutationFn: admin.stopStream,  onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-stream-status'] }) });

  const [vCfgApiKey, setVCfgApiKey] = useState('');
  const [vCfgBaseUrl, setVCfgBaseUrl] = useState('');
  const [vCfgWsUrl, setVCfgWsUrl] = useState('');
  const [vCfgAppId, setVCfgAppId] = useState('');
  const [vCfgMsg, setVCfgMsg] = useState<string | null>(null);
  const [vCfgErr, setVCfgErr] = useState<string | null>(null);

  const vCfgMut = useMutation({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mutationFn: () => (admin as any).updateVayuConfig({ apiKey: vCfgApiKey || undefined, baseUrl: vCfgBaseUrl || undefined, wsUrl: vCfgWsUrl || undefined, appId: vCfgAppId || undefined }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSuccess: (data: any) => {
      setVCfgMsg(data?.message ?? 'Updated');
      setVCfgErr(null);
      setVCfgApiKey(''); setVCfgBaseUrl(''); setVCfgWsUrl(''); setVCfgAppId('');
      void qc.invalidateQueries({ queryKey: ['vayu-config'] });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onError: (e: any) => { setVCfgErr(e?.message || 'Update failed'); setVCfgMsg(null); },
  });

  if (!token) {
    return <section className="card"><p className="err">Add an admin token in Settings.</p></section>;
  }

  const providerLabel = globalProv.data ? adminProviderLabel(globalProv.data) : '—';
  const streamData = stream.data as Record<string, unknown> | undefined;
  const isStreaming = streamData?.isStreaming === true;
  const streamRows = stream.data ? streamSummaryRows(stream.data) : [];
  const streamExtra = streamRows.length ? streamRows : flattenObject(stream.data, '', 2);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vCfgData = vayuConfig.data as any;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      {/* ── Page header ─────────────────────────────────────── */}
      <div className="page-head">
        <h1>PROVIDER &amp; STREAM CONTROL</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Dot variant={isStreaming ? 'ok' : 'off'} />
          <span style={{ fontSize: 11, fontWeight: 700, color: isStreaming ? 'var(--ok)' : 'var(--muted)' }}>
            {isStreaming ? `LIVE · ${providerLabel.toUpperCase()}` : 'STREAM OFFLINE'}
          </span>
        </div>
      </div>

      {/* ── Top 2-column grid ────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {/* Provider selector */}
        <div className="panel" style={{ minHeight: 160 }}>
          <div className="panel__head">
            <span className="panel__title">GLOBAL WS PROVIDER</span>
            <span className="panel__title-val">{providerLabel.toUpperCase()}</span>
          </div>
          <div className="panel__body">
            <ErrorInline message={globalProv.isError ? (globalProv.error as Error).message : null} />
            <StatRow
              label="Active provider"
              value={providerLabel === '—' ? 'Not set' : providerLabel.toUpperCase()}
              variant={providerLabel !== '—' ? 'ok' : undefined}
            />
            {flattenObject(globalProv.data, '', 2).map((r) => (
              r.label !== 'provider' && <StatRow key={r.label} label={r.label} value={r.value} />
            ))}
            <div className="panel-section-title" style={{ marginTop: 8 }}>SWITCH PROVIDER</div>
            <div className="provider-btns" style={{ marginTop: 4 }}>
              {([['kite', 'FALCON (KITE)'], ['vortex', 'VAYU (VORTEX)']] as const).map(([p, label]) => (
                <button
                  key={p}
                  type="button"
                  className={`provider-btn ${providerLabel.toLowerCase() === p ? 'provider-btn--active' : ''}`}
                  onClick={() => setProv.mutate(p)}
                  disabled={setProv.isPending}
                >
                  {label}
                </button>
              ))}
            </div>
            {setProv.isError && <p className="err" style={{ fontSize: 10, marginTop: 4 }}>{(setProv.error as Error).message}</p>}
          </div>
        </div>

        {/* Stream control */}
        <div className="panel" style={{ minHeight: 160 }}>
          <div className="panel__head">
            <span className="panel__title">STREAM STATUS</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Dot variant={isStreaming ? 'ok' : 'off'} />
              <span className="panel__title-val" style={{ color: isStreaming ? 'var(--ok)' : 'var(--muted)' }}>
                {isStreaming ? 'LIVE' : 'OFFLINE'}
              </span>
            </span>
          </div>
          <div className="panel__body">
            <ErrorInline message={stream.isError ? (stream.error as Error).message : null} />
            {streamExtra.map((r) => (
              <StatRow key={r.label} label={r.label} value={String(r.value)}
                variant={r.label === 'Streaming' ? (String(r.value) === 'Yes' ? 'ok' : 'warn') : undefined} />
            ))}
            <div className="panel-section-title" style={{ marginTop: 8 }}>CONTROLS</div>
            <div className="stream-btns" style={{ marginTop: 4 }}>
              <button type="button" className="stream-btn-start" onClick={() => start.mutate()} disabled={start.isPending || isStreaming}>
                ▶ START STREAM
              </button>
              <button type="button" className="stream-btn-stop" onClick={() => stop.mutate()} disabled={stop.isPending || !isStreaming}>
                ■ STOP STREAM
              </button>
            </div>
            {(start.isError || stop.isError) && (
              <p className="err" style={{ fontSize: 10, marginTop: 4 }}>{((start.error || stop.error) as Error).message}</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Vayu credentials ─────────────────────────────────── */}
      <div className="panel">
        <div className="panel__head">
          <span className="panel__title">VAYU (VORTEX) API CREDENTIALS</span>
          {vCfgData?.hasAccessToken && (
            <span className="cc-chip cc-chip--ok" style={{ fontSize: 9 }}>TOKEN SET</span>
          )}
        </div>
        <div className="panel__body">
          <p style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
            Update Vortex credentials without SSH. Stored in the database; persists across restarts.
            After updating, re-authenticate at <code style={{ fontSize: 10 }}>/api/auth/vayu/login</code>.
          </p>
          {vCfgData && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, marginBottom: 10 }}>
              {[
                { label: 'API Key', val: `${vCfgData.apiKey?.masked ?? '—'} · ${vCfgData.apiKey?.source ?? '?'}` },
                { label: 'App ID',  val: `${vCfgData.appId?.masked  ?? '—'} · ${vCfgData.appId?.source  ?? '?'}` },
                { label: 'Base URL',val: `${vCfgData.baseUrl?.value ?? '—'} · ${vCfgData.baseUrl?.source ?? '?'}` },
                { label: 'WS URL',  val: `${vCfgData.wsUrl?.value   ?? '—'} · ${vCfgData.wsUrl?.source   ?? '?'}` },
                { label: 'HTTP Client', val: vCfgData.initialized ? 'Ready' : 'Not Ready' },
                { label: 'Access Token', val: vCfgData.hasAccessToken ? 'Set' : 'Not set' },
              ].map((r) => (
                <div key={r.label} className="stat-chip" style={{ minWidth: 0 }}>
                  <div className="stat-chip__label">{r.label.toUpperCase()}</div>
                  <div style={{ fontSize: 10, color: 'var(--text)', fontFamily: 'ui-monospace,monospace', wordBreak: 'break-all' }}>{r.val}</div>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6 }}>
            {[
              { label: 'API Key', val: vCfgApiKey, set: setVCfgApiKey, placeholder: 'VORTEX_API_KEY' },
              { label: 'App ID',  val: vCfgAppId,  set: setVCfgAppId,  placeholder: 'VORTEX_APP_ID' },
              { label: 'Base URL',val: vCfgBaseUrl, set: setVCfgBaseUrl,placeholder: 'https://vortex-api…' },
              { label: 'WS URL',  val: vCfgWsUrl,  set: setVCfgWsUrl,  placeholder: 'wss://wire…' },
            ].map(({ label, val, set, placeholder }) => (
              <div key={label}>
                <label style={{ fontSize: 10, marginBottom: 2 }}>{label}</label>
                <input value={val} onChange={(e) => set(e.target.value)} placeholder={placeholder} style={{ fontSize: 11, padding: '4px 6px' }} autoComplete="off" />
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className="btn-xs"
              onClick={() => vCfgMut.mutate()}
              disabled={vCfgMut.isPending || (!vCfgApiKey && !vCfgBaseUrl && !vCfgWsUrl && !vCfgAppId)}
            >
              {vCfgMut.isPending ? 'Saving…' : 'Save Vayu Credentials'}
            </button>
            {vCfgMsg && <span style={{ color: 'var(--ok)', fontSize: 11 }}>{vCfgMsg}</span>}
            {vCfgErr && <span style={{ color: 'var(--bad)', fontSize: 11 }}>{vCfgErr}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
