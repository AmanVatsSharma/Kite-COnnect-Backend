import { useQuery } from '@tanstack/react-query';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import * as pub from '../lib/public-api';
import { JsonBlock } from '../components/JsonBlock';

const poll = 5000;

export function OverviewPage() {
  const token = getAdminToken();

  const health = useQuery({
    queryKey: ['health'],
    queryFn: pub.getHealth,
    refetchInterval: poll,
  });

  const mdHealth = useQuery({
    queryKey: ['health-md'],
    queryFn: pub.getMarketDataHealth,
    refetchInterval: poll,
  });

  const stats = useQuery({
    queryKey: ['stock-stats'],
    queryFn: pub.getStockStats,
    refetchInterval: poll,
  });

  const globalProv = useQuery({
    queryKey: ['admin-global-provider'],
    queryFn: admin.getGlobalProvider,
    enabled: !!token,
    refetchInterval: poll,
  });

  const stream = useQuery({
    queryKey: ['admin-stream-status'],
    queryFn: admin.getStreamStatus,
    enabled: !!token,
    refetchInterval: poll,
  });

  const ws = useQuery({
    queryKey: ['admin-ws-status'],
    queryFn: admin.getWsStatus,
    enabled: !!token,
    refetchInterval: poll,
  });

  return (
    <>
      <section className="card">
        <h2>Public health (live)</h2>
        <div className="grid2">
          <div>
            <div className="muted">GET /api/health</div>
            {health.isError && <p className="err">{(health.error as Error).message}</p>}
            {health.data && <JsonBlock value={health.data} />}
          </div>
          <div>
            <div className="muted">GET /api/health/market-data</div>
            {mdHealth.isError && <p className="err">{(mdHealth.error as Error).message}</p>}
            {mdHealth.data && <JsonBlock value={mdHealth.data} />}
          </div>
          <div>
            <div className="muted">GET /api/stock/stats</div>
            {stats.isError && <p className="err">{(stats.error as Error).message}</p>}
            {stats.data && <JsonBlock value={stats.data} />}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Admin live (needs token)</h2>
        {!token && <p className="muted">No admin token — only public panels above refresh.</p>}
        {token && (
          <div className="grid2">
            <div>
              <div className="muted">Global provider</div>
              {globalProv.isError && <p className="err">{(globalProv.error as Error).message}</p>}
              {globalProv.data && <JsonBlock value={globalProv.data} />}
            </div>
            <div>
              <div className="muted">Stream status</div>
              {stream.isError && <p className="err">{(stream.error as Error).message}</p>}
              {stream.data && <JsonBlock value={stream.data} />}
            </div>
            <div>
              <div className="muted">WebSocket status</div>
              {ws.isError && <p className="err">{(ws.error as Error).message}</p>}
              {ws.data && <JsonBlock value={ws.data} />}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
