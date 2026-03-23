import { useQuery } from '@tanstack/react-query';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import { JsonBlock } from '../components/JsonBlock';

export function AuditDebugPage() {
  const token = getAdminToken();

  const audit = useQuery({
    queryKey: ['admin-audit-config'],
    queryFn: admin.getAuditConfig,
    enabled: !!token,
  });

  const falcon = useQuery({
    queryKey: ['admin-debug-falcon'],
    queryFn: admin.getKiteDebug,
    enabled: !!token,
    refetchInterval: 10000,
  });

  const vayu = useQuery({
    queryKey: ['admin-debug-vayu'],
    queryFn: admin.getVortexDebug,
    enabled: !!token,
    refetchInterval: 10000,
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
        <h2>Audit sampling config</h2>
        {audit.isError && <p className="err">{(audit.error as Error).message}</p>}
        {audit.data && <JsonBlock value={audit.data} />}
      </section>

      <section className="card">
        <h2>Falcon (Kite) debug</h2>
        {falcon.isError && <p className="err">{(falcon.error as Error).message}</p>}
        {falcon.data && <JsonBlock value={falcon.data} />}
      </section>

      <section className="card">
        <h2>Vayu (Vortex) debug</h2>
        {vayu.isError && <p className="err">{(vayu.error as Error).message}</p>}
        {vayu.data && <JsonBlock value={vayu.data} />}
      </section>
    </>
  );
}
