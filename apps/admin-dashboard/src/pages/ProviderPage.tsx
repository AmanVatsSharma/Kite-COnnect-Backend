/**
 * @file ProviderPage.tsx
 * @module admin-dashboard
 * @description Global market-data provider and stream controls with structured status + raw JSON.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import { ErrorInline } from '../components/ErrorInline';
import { KeyValueGrid } from '../components/KeyValueGrid';
import { RawJsonDetails } from '../components/RawJsonDetails';
import { SectionCard } from '../components/section-card';
import { StatusBadge } from '../components/StatusBadge';
import { adminProviderLabel, streamSummaryRows } from '../lib/views/overview-views';
import { flattenObject } from '../lib/views/flatten';

export function ProviderPage() {
  const token = getAdminToken();
  const qc = useQueryClient();

  const globalProv = useQuery({
    queryKey: ['admin-global-provider'],
    queryFn: admin.getGlobalProvider,
    enabled: !!token,
  });

  const stream = useQuery({
    queryKey: ['admin-stream-status'],
    queryFn: admin.getStreamStatus,
    enabled: !!token,
  });

  const setProv = useMutation({
    mutationFn: (provider: 'kite' | 'vortex') => admin.setGlobalProvider(provider),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-global-provider'] });
      void qc.invalidateQueries({ queryKey: ['admin-stream-status'] });
    },
  });

  const start = useMutation({
    mutationFn: admin.startStream,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-stream-status'] }),
  });

  const stop = useMutation({
    mutationFn: admin.stopStream,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-stream-status'] }),
  });

  // ── Vayu credentials config ──
  const vayuConfig = useQuery({
    queryKey: ['vayu-config'],
    queryFn: admin.getVayuConfig,
    enabled: !!token,
  });
  const [vCfgApiKey, setVCfgApiKey] = useState('');
  const [vCfgBaseUrl, setVCfgBaseUrl] = useState('');
  const [vCfgWsUrl, setVCfgWsUrl] = useState('');
  const [vCfgAppId, setVCfgAppId] = useState('');
  const [vCfgMsg, setVCfgMsg] = useState<string | null>(null);
  const [vCfgErr, setVCfgErr] = useState<string | null>(null);
  const vCfgMut = useMutation({
    mutationFn: () => admin.updateVayuConfig({
      apiKey: vCfgApiKey || undefined,
      baseUrl: vCfgBaseUrl || undefined,
      wsUrl: vCfgWsUrl || undefined,
      appId: vCfgAppId || undefined,
    }),
    onSuccess: (data: any) => {
      setVCfgMsg(data?.message ?? 'Updated');
      setVCfgErr(null);
      setVCfgApiKey(''); setVCfgBaseUrl(''); setVCfgWsUrl(''); setVCfgAppId('');
      void qc.invalidateQueries({ queryKey: ['vayu-config'] });
    },
    onError: (e: any) => { setVCfgErr(e?.message || 'Update failed'); setVCfgMsg(null); },
  });

  if (!token) {
    return (
      <section className="card">
        <p className="err">Add an admin token in Settings.</p>
      </section>
    );
  }

  const providerLabel = globalProv.data ? adminProviderLabel(globalProv.data) : '—';
  const streamRows = stream.data ? streamSummaryRows(stream.data) : [];
  const streamFallback = stream.data && !streamRows.length ? flattenObject(stream.data, '', 2) : streamRows;

  return (
    <>
      <section className="card">
        <h2>Global WebSocket provider</h2>
        <ErrorInline message={globalProv.isError ? (globalProv.error as Error).message : null} />
        {globalProv.data && (
          <>
            <div className="overview-strip">
              <span className="muted">Active provider</span>
              <StatusBadge variant={providerLabel !== '—' ? 'ok' : 'neutral'}>
                {providerLabel === '—' ? 'Not set' : providerLabel}
              </StatusBadge>
            </div>
            <KeyValueGrid rows={flattenObject(globalProv.data, '', 2).map((r) => ({ label: r.label, value: r.value }))} />
            <RawJsonDetails value={globalProv.data} summary="Technical details (raw JSON)" />
          </>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" className="btn" disabled={setProv.isPending} onClick={() => setProv.mutate('kite')}>
            Set Kite (Falcon)
          </button>
          <button type="button" className="btn" disabled={setProv.isPending} onClick={() => setProv.mutate('vortex')}>
            Set Vortex (Vayu)
          </button>
        </div>
        {setProv.isError && <p className="err">{(setProv.error as Error).message}</p>}
      </section>

      <section className="card">
        <h2>Streaming</h2>
        <ErrorInline message={stream.isError ? (stream.error as Error).message : null} />
        {stream.data && (
          <>
            <KeyValueGrid rows={streamFallback.map((r) => ({ label: r.label, value: r.value }))} />
            <RawJsonDetails value={stream.data} summary="Technical details (raw JSON)" />
          </>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" className="btn" disabled={start.isPending} onClick={() => start.mutate()}>
            Start stream
          </button>
          <button type="button" className="btn btn-danger" disabled={stop.isPending} onClick={() => stop.mutate()}>
            Stop stream
          </button>
        </div>
        {(start.isError || stop.isError) && (
          <p className="err">{((start.error || stop.error) as Error).message}</p>
        )}
      </section>

      {/* ── Vayu (Vortex) API Credentials ── */}
      <SectionCard title="Vayu (Vortex) API Credentials" collapsible defaultOpen={!(vayuConfig.data as any)?.apiKey?.hasValue}>
        <p style={{ fontSize: 12, marginBottom: 10, color: '#888' }}>
          Update Vortex credentials without SSH. Stored in the database; override persists across restarts.
          After updating, re-authenticate at <strong>/api/auth/vayu/login</strong>.
        </p>
        {vayuConfig.data && (() => {
          const d = vayuConfig.data as any;
          return (
            <KeyValueGrid rows={[
              { label: 'API Key', value: `${d.apiKey?.masked ?? '—'} (source: ${d.apiKey?.source ?? '?'})` },
              { label: 'App ID', value: `${d.appId?.masked ?? '—'} (source: ${d.appId?.source ?? '?'})` },
              { label: 'Base URL', value: `${d.baseUrl?.value ?? '—'} (source: ${d.baseUrl?.source ?? '?'})` },
              { label: 'WS URL', value: `${d.wsUrl?.value ?? '—'} (source: ${d.wsUrl?.source ?? '?'})` },
              { label: 'HTTP Client', value: d.initialized ? 'Ready' : 'Not Ready' },
              { label: 'Access Token', value: d.hasAccessToken ? 'Set' : 'Not set' },
            ]} />
          );
        })()}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, color: '#888' }}>API Key</label>
            <input placeholder="VORTEX_API_KEY" value={vCfgApiKey} onChange={(e) => setVCfgApiKey(e.target.value)} autoComplete="off" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, color: '#888' }}>App ID</label>
            <input placeholder="VORTEX_APP_ID" value={vCfgAppId} onChange={(e) => setVCfgAppId(e.target.value)} autoComplete="off" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, color: '#888' }}>Base URL</label>
            <input placeholder="https://vortex-api.rupeezy.in/v2" value={vCfgBaseUrl} onChange={(e) => setVCfgBaseUrl(e.target.value)} autoComplete="off" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, color: '#888' }}>WS URL</label>
            <input placeholder="wss://wire.rupeezy.in/ws" value={vCfgWsUrl} onChange={(e) => setVCfgWsUrl(e.target.value)} autoComplete="off" />
          </div>
        </div>
        <button
          style={{ marginTop: 10 }}
          onClick={() => vCfgMut.mutate()}
          disabled={vCfgMut.isPending || (!vCfgApiKey.trim() && !vCfgBaseUrl.trim() && !vCfgWsUrl.trim() && !vCfgAppId.trim())}
        >
          {vCfgMut.isPending ? 'Saving…' : 'Save Vayu Credentials'}
        </button>
        {vCfgMsg && <p style={{ color: '#26a69a', fontSize: 12, marginTop: 6 }}>{vCfgMsg}</p>}
        {vCfgErr && <p style={{ color: '#ef5350', fontSize: 12, marginTop: 6 }}>{vCfgErr}</p>}
      </SectionCard>
    </>
  );
}
