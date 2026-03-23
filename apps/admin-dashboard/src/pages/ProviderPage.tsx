import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import { JsonBlock } from '../components/JsonBlock';

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
    refetchInterval: 4000,
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

  return (
    <>
      <section className="card">
        <h2>Global WebSocket provider</h2>
        {globalProv.data && <JsonBlock value={globalProv.data} />}
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
        {stream.data && <JsonBlock value={stream.data} />}
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
