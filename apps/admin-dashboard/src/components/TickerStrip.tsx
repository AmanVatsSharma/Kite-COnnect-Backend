/**
 * @file TickerStrip.tsx
 * @module admin-dashboard
 * @description Marquee-style operational ticker from shared live admin metrics.
 * @author BharatERP
 * @created 2026-03-28
 */

import { buildTickerSegments } from '../lib/views/overview-views';
import { useLiveAdminMetrics } from '../hooks/useLiveAdminMetrics';

export function TickerStrip() {
  const { token, health, mdHealth, stats, globalProv, stream, ws } = useLiveAdminMetrics();

  const text = buildTickerSegments({
    health: health.data,
    mdHealth: mdHealth.data,
    stats: stats.data,
    globalProv: globalProv.data,
    stream: stream.data,
    ws: ws.data,
    hasAdminToken: !!token,
  }).join('   ·   ');

  const dup = `${text}   ·   ${text}`;

  return (
    <div className="ticker-strip" aria-live="polite">
      <span className="ticker-strip__label">LIVE</span>
      <div className="ticker-strip__viewport">
        <div className="ticker-strip__track">{dup}</div>
      </div>
    </div>
  );
}
