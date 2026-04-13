/**
 * @file ProviderPage.tsx
 * @module admin-dashboard
 * @description Global market-data provider and stream controls with structured status + raw JSON.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import { ErrorInline } from '../components/ErrorInline';
import { KeyValueGrid } from '../components/KeyValueGrid';
import { RawJsonDetails } from '../components/RawJsonDetails';
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
    </>
  );
}
