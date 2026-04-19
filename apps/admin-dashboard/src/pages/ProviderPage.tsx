/**
 * @file ProviderPage.tsx
 * @module admin-dashboard
 * @description Provider ops: global WS provider selector, stream controls, per-provider credentials.
 * @author BharatERP
 * @updated 2026-04-19
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

function SourceBadge({ source }: { source?: 'db' | 'env' | 'none' | 'default' }) {
  const color = source === 'db' ? 'var(--ok)' : source === 'env' ? 'var(--warn)' : 'var(--muted)';
  return (
    <span style={{ fontSize: 9, fontWeight: 700, color, marginLeft: 4, textTransform: 'uppercase' }}>
      [{source ?? 'none'}]
    </span>
  );
}

function CredField({
  label, val, setVal, placeholder, type = 'text',
}: { label: string; val: string; setVal: (v: string) => void; placeholder: string; type?: string }) {
  return (
    <div>
      <label style={{ fontSize: 10, marginBottom: 2, display: 'block' }}>{label}</label>
      <input
        type={type}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder={placeholder}
        style={{ fontSize: 11, padding: '4px 6px', width: '100%', boxSizing: 'border-box' }}
        autoComplete="off"
      />
    </div>
  );
}

export function ProviderPage() {
  const token = getAdminToken();
  const qc = useQueryClient();

  // Queries
  const globalProv = useQuery({ queryKey: ['admin-global-provider'], queryFn: admin.getGlobalProvider, enabled: !!token });
  const stream = useQuery({ queryKey: ['admin-stream-status'], queryFn: admin.getStreamStatus, enabled: !!token });
  const kiteConfig = useQuery({ queryKey: ['kite-config'], queryFn: admin.getKiteConfig, enabled: !!token });
  const vayuConfig = useQuery({ queryKey: ['vayu-config'], queryFn: admin.getVayuConfig, enabled: !!token });
  const massiveConfig = useQuery({ queryKey: ['massive-config'], queryFn: admin.getMassiveConfig, enabled: !!token });

  // Provider switch + stream controls
  const setProv = useMutation({
    mutationFn: (provider: 'kite' | 'vortex') => admin.setGlobalProvider(provider),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-global-provider'] });
      void qc.invalidateQueries({ queryKey: ['admin-stream-status'] });
    },
  });
  const start = useMutation({ mutationFn: admin.startStream, onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-stream-status'] }) });
  const stop  = useMutation({ mutationFn: admin.stopStream,  onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-stream-status'] }) });

  // Kite credential form state
  const [kApiKey, setKApiKey] = useState('');
  const [kApiSecret, setKApiSecret] = useState('');
  const [kMsg, setKMsg] = useState<string | null>(null);
  const [kErr, setKErr] = useState<string | null>(null);
  const kiteMut = useMutation({
    mutationFn: () => admin.setKiteCredentials({ apiKey: kApiKey || undefined, apiSecret: kApiSecret || undefined }),
    onSuccess: () => {
      setKMsg('Saved'); setKErr(null);
      setKApiKey(''); setKApiSecret('');
      void qc.invalidateQueries({ queryKey: ['kite-config'] });
    },
    onError: (e: unknown) => { setKErr((e as Error)?.message || 'Update failed'); setKMsg(null); },
  });

  // Vortex / Vayu credential form state
  const [vApiKey, setVApiKey] = useState('');
  const [vAppId, setVAppId] = useState('');
  const [vBaseUrl, setVBaseUrl] = useState('');
  const [vWsUrl, setVWsUrl] = useState('');
  const [vMsg, setVMsg] = useState<string | null>(null);
  const [vErr, setVErr] = useState<string | null>(null);
  const vortexMut = useMutation({
    mutationFn: () => admin.updateVayuConfig({ apiKey: vApiKey || undefined, appId: vAppId || undefined, baseUrl: vBaseUrl || undefined, wsUrl: vWsUrl || undefined }),
    onSuccess: () => {
      setVMsg('Saved'); setVErr(null);
      setVApiKey(''); setVAppId(''); setVBaseUrl(''); setVWsUrl('');
      void qc.invalidateQueries({ queryKey: ['vayu-config'] });
    },
    onError: (e: unknown) => { setVErr((e as Error)?.message || 'Update failed'); setVMsg(null); },
  });

  // Massive credential form state
  const [mApiKey, setMApiKey] = useState('');
  const [mRealtime, setMRealtime] = useState(false);
  const [mAssetClass, setMAssetClass] = useState('');
  const [mMsg, setMMsg] = useState<string | null>(null);
  const [mErr, setMErr] = useState<string | null>(null);
  const massiveMut = useMutation({
    mutationFn: () => admin.setMassiveCredentials({
      apiKey: mApiKey || undefined,
      realtime: mRealtime,
      assetClass: mAssetClass || undefined,
    }),
    onSuccess: () => {
      setMMsg('Saved'); setMErr(null);
      setMApiKey(''); setMAssetClass('');
      void qc.invalidateQueries({ queryKey: ['massive-config'] });
    },
    onError: (e: unknown) => { setMErr((e as Error)?.message || 'Update failed'); setMMsg(null); },
  });

  if (!token) {
    return <section className="card"><p className="err">Add an admin token in Settings.</p></section>;
  }

  const providerLabel = globalProv.data ? adminProviderLabel(globalProv.data) : '—';
  const streamData = stream.data as Record<string, unknown> | undefined;
  const isStreaming = streamData?.isStreaming === true;
  const streamRows = stream.data ? streamSummaryRows(stream.data) : [];
  const streamExtra = streamRows.length ? streamRows : flattenObject(stream.data, '', 2);
  const kd = kiteConfig.data;
  const vd = vayuConfig.data;
  const md = massiveConfig.data;

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
            <span className="panel__title">HTTP PROVIDER (REST QUERIES)</span>
            <span className="panel__title-val">{providerLabel.toUpperCase()}</span>
          </div>
          <div className="panel__body">
            <ErrorInline message={globalProv.isError ? (globalProv.error as Error).message : null} />
            <p style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.4 }}>
              Sets the default provider for HTTP quote requests. WebSocket streaming uses automatic per-exchange routing.
            </p>
            <StatRow label="Active provider" value={providerLabel === '—' ? 'Not set' : providerLabel.toUpperCase()} variant={providerLabel !== '—' ? 'ok' : undefined} />
            {flattenObject(globalProv.data, '', 2).map((r) => (
              r.label !== 'provider' && <StatRow key={r.label} label={r.label} value={r.value} />
            ))}
            <div className="panel-section-title" style={{ marginTop: 8 }}>SWITCH HTTP PROVIDER</div>
            <div className="provider-btns" style={{ marginTop: 4 }}>
              {([['kite', 'FALCON (KITE)'], ['vortex', 'VAYU (VORTEX)']] as const).map(([p, label]) => (
                <button key={p} type="button"
                  className={`provider-btn ${providerLabel.toLowerCase() === p ? 'provider-btn--active' : ''}`}
                  onClick={() => setProv.mutate(p)} disabled={setProv.isPending}>
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
              <button type="button" className="stream-btn-start" onClick={() => start.mutate()} disabled={start.isPending || isStreaming}>▶ START STREAM</button>
              <button type="button" className="stream-btn-stop"  onClick={() => stop.mutate()}  disabled={stop.isPending || !isStreaming}>■ STOP STREAM</button>
            </div>
            {(start.isError || stop.isError) && (
              <p className="err" style={{ fontSize: 10, marginTop: 4 }}>{((start.error || stop.error) as Error).message}</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Credential panels 3-column ─────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>

        {/* Falcon (Kite) credentials */}
        <div className="panel">
          <div className="panel__head">
            <span className="panel__title">FALCON (KITE) CREDENTIALS</span>
            {kd?.accessToken?.masked && <span className="cc-chip cc-chip--ok" style={{ fontSize: 9 }}>TOKEN SET</span>}
          </div>
          <div className="panel__body">
            <p style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
              Stored in DB; overrides <code style={{ fontSize: 10 }}>KITE_API_KEY</code> env var.
            </p>
            {kd && (
              <div style={{ marginBottom: 8 }}>
                {[
                  { label: 'API Key', m: kd.apiKey?.masked, src: kd.apiKey?.source },
                  { label: 'API Secret', m: kd.apiSecret?.masked, src: kd.apiSecret?.source },
                  { label: 'Access Token', m: kd.accessToken?.masked, src: kd.accessToken?.source },
                ].map((r) => (
                  <div key={r.label} style={{ fontSize: 10, marginBottom: 2 }}>
                    <span style={{ color: 'var(--muted)' }}>{r.label}:</span>{' '}
                    <code style={{ fontSize: 10 }}>{r.m ?? '—'}</code>
                    <SourceBadge source={r.src as 'db' | 'env' | 'none'} />
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <CredField label="API Key" val={kApiKey} setVal={setKApiKey} placeholder="KITE_API_KEY" />
              <CredField label="API Secret" val={kApiSecret} setVal={setKApiSecret} placeholder="KITE_API_SECRET" type="password" />
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn-xs" onClick={() => kiteMut.mutate()}
                disabled={kiteMut.isPending || (!kApiKey && !kApiSecret)}>
                {kiteMut.isPending ? 'Saving…' : 'Save Falcon Credentials'}
              </button>
              {kMsg && <span style={{ color: 'var(--ok)', fontSize: 11 }}>{kMsg}</span>}
              {kErr && <span style={{ color: 'var(--bad)', fontSize: 11 }}>{kErr}</span>}
            </div>
          </div>
        </div>

        {/* Vayu (Vortex) credentials */}
        <div className="panel">
          <div className="panel__head">
            <span className="panel__title">VAYU (VORTEX) CREDENTIALS</span>
            {vd?.hasAccessToken && <span className="cc-chip cc-chip--ok" style={{ fontSize: 9 }}>TOKEN SET</span>}
          </div>
          <div className="panel__body">
            <p style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
              Stored in DB; overrides <code style={{ fontSize: 10 }}>VORTEX_*</code> env vars.
            </p>
            {vd && (
              <div style={{ marginBottom: 8 }}>
                {[
                  { label: 'API Key', m: vd.apiKey?.masked, src: vd.apiKey?.source },
                  { label: 'App ID', m: vd.appId?.masked, src: vd.appId?.source },
                  { label: 'Base URL', m: (vd.baseUrl as any)?.value ?? null, src: (vd.baseUrl as any)?.source },
                  { label: 'WS URL', m: (vd.wsUrl as any)?.value ?? null, src: (vd.wsUrl as any)?.source },
                ].map((r) => (
                  <div key={r.label} style={{ fontSize: 10, marginBottom: 2 }}>
                    <span style={{ color: 'var(--muted)' }}>{r.label}:</span>{' '}
                    <code style={{ fontSize: 10 }}>{r.m ?? '—'}</code>
                    <SourceBadge source={r.src as 'db' | 'env' | 'none' | 'default'} />
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <CredField label="API Key" val={vApiKey} setVal={setVApiKey} placeholder="VORTEX_API_KEY" />
              <CredField label="App ID" val={vAppId} setVal={setVAppId} placeholder="VORTEX_APP_ID" />
              <CredField label="Base URL" val={vBaseUrl} setVal={setVBaseUrl} placeholder="https://vortex-api…" />
              <CredField label="WS URL" val={vWsUrl} setVal={setVWsUrl} placeholder="wss://wire…" />
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn-xs" onClick={() => vortexMut.mutate()}
                disabled={vortexMut.isPending || (!vApiKey && !vAppId && !vBaseUrl && !vWsUrl)}>
                {vortexMut.isPending ? 'Saving…' : 'Save Vayu Credentials'}
              </button>
              {vMsg && <span style={{ color: 'var(--ok)', fontSize: 11 }}>{vMsg}</span>}
              {vErr && <span style={{ color: 'var(--bad)', fontSize: 11 }}>{vErr}</span>}
            </div>
          </div>
        </div>

        {/* Massive (Polygon) credentials */}
        <div className="panel">
          <div className="panel__head">
            <span className="panel__title">MASSIVE (POLYGON) CREDENTIALS</span>
            {md && !md.degraded && <span className="cc-chip cc-chip--ok" style={{ fontSize: 9 }}>READY</span>}
            {md?.degraded && <span className="cc-chip cc-chip--bad" style={{ fontSize: 9 }}>DEGRADED</span>}
          </div>
          <div className="panel__body">
            <p style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
              Stored in DB; overrides <code style={{ fontSize: 10 }}>MASSIVE_API_KEY</code> env var.
            </p>
            {md && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 10, marginBottom: 2 }}>
                  <span style={{ color: 'var(--muted)' }}>API Key:</span>{' '}
                  <code style={{ fontSize: 10 }}>{md.apiKey?.masked ?? '—'}</code>
                  <SourceBadge source={md.apiKey?.source} />
                </div>
                <div style={{ fontSize: 10, marginBottom: 2 }}>
                  <span style={{ color: 'var(--muted)' }}>Mode:</span>{' '}
                  <span style={{ color: md.realtime ? 'var(--ok)' : 'var(--warn)' }}>
                    {md.realtime ? 'Realtime' : 'Delayed'}
                  </span>
                </div>
                <div style={{ fontSize: 10 }}>
                  <span style={{ color: 'var(--muted)' }}>Asset Class:</span>{' '}
                  <code style={{ fontSize: 10 }}>{md.assetClass}</code>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <CredField label="API Key" val={mApiKey} setVal={setMApiKey} placeholder="MASSIVE_API_KEY" />
              <div>
                <label style={{ fontSize: 10, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={mRealtime} onChange={(e) => setMRealtime(e.target.checked)} />
                  Realtime feed (default: delayed)
                </label>
              </div>
              <div>
                <label style={{ fontSize: 10, marginBottom: 2, display: 'block' }}>Asset Class</label>
                <select value={mAssetClass} onChange={(e) => setMAssetClass(e.target.value)}
                  style={{ fontSize: 11, padding: '4px 6px', width: '100%' }}>
                  <option value="">— keep current —</option>
                  <option value="stocks">Stocks</option>
                  <option value="crypto">Crypto</option>
                  <option value="forex">Forex</option>
                  <option value="options">Options</option>
                </select>
              </div>
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn-xs" onClick={() => massiveMut.mutate()}
                disabled={massiveMut.isPending || (!mApiKey && !mAssetClass)}>
                {massiveMut.isPending ? 'Saving…' : 'Save Massive Credentials'}
              </button>
              {mMsg && <span style={{ color: 'var(--ok)', fontSize: 11 }}>{mMsg}</span>}
              {mErr && <span style={{ color: 'var(--bad)', fontSize: 11 }}>{mErr}</span>}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
