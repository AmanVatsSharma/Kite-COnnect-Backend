/**
 * @file overview-views.ts
 * @module admin-dashboard
 * @description Parse health / stats payloads for structured Overview UI and ticker.
 * @author BharatERP
 * @created 2026-03-28
 * @updated 2026-03-28
 */

import { flattenObject, type KvRow } from './flatten';

export function healthOverallStatus(data: unknown): 'ok' | 'warn' | 'bad' {
  if (!data || typeof data !== 'object') return 'bad';
  const s = String((data as Record<string, unknown>).status || '').toLowerCase();
  if (s === 'healthy') return 'ok';
  if (s === 'unhealthy') return 'bad';
  return 'warn';
}

export function healthServiceRows(data: unknown): KvRow[] {
  if (!data || typeof data !== 'object') return [];
  const services = (data as Record<string, unknown>).services;
  if (!services || typeof services !== 'object') return [];
  return Object.entries(services as Record<string, unknown>).map(([k, v]) => ({
    label: k,
    value: String(v),
  }));
}

export function marketDataSummaryRows(data: unknown): KvRow[] {
  if (!data || typeof data !== 'object') return [];
  const o = data as Record<string, unknown>;
  const rows: KvRow[] = [];
  if (o.provider !== undefined) rows.push({ label: 'Global provider', value: String(o.provider) });
  if (o.timestamp) rows.push({ label: 'Timestamp', value: String(o.timestamp) });
  const streaming = o.streaming;
  if (streaming && typeof streaming === 'object') {
    const st = streaming as Record<string, unknown>;
    if (st.isStreaming !== undefined) rows.push({ label: 'Streaming', value: st.isStreaming ? 'Active' : 'Inactive' });
    if (st.providerName !== undefined) rows.push({ label: 'Stream provider', value: String(st.providerName) });
  }
  const md = o.marketData;
  if (md && typeof md === 'object') {
    for (const [k, v] of Object.entries(md as Record<string, unknown>)) {
      if (typeof v === 'boolean') rows.push({ label: `Market ${k}`, value: v ? 'Yes' : 'No' });
      else if (typeof v === 'string' || typeof v === 'number') rows.push({ label: `Market ${k}`, value: String(v) });
    }
  }
  const vortex = o.vortex;
  if (vortex && typeof vortex === 'object') {
    const vx = vortex as Record<string, unknown>;
    if (vx.httpOk !== undefined) rows.push({ label: 'Vortex HTTP', value: vx.httpOk ? 'Reachable' : 'Unreachable' });
  }
  return rows;
}

export function stockStatsMetricCards(data: unknown): { label: string; value: string; hint?: string }[] {
  if (!data || typeof data !== 'object') return [];
  const o = data as Record<string, unknown>;
  const cards: { label: string; value: string; hint?: string }[] = [];
  if (typeof o.instruments === 'number') cards.push({ label: 'Instruments', value: String(o.instruments) });
  if (typeof o.marketDataRecords === 'number') {
    cards.push({ label: 'Market data rows', value: String(o.marketDataRecords) });
  }
  if (typeof o.activeSubscriptions === 'number') {
    cards.push({ label: 'Active subscriptions', value: String(o.activeSubscriptions) });
  }
  const conn = o.connectionStats;
  if (conn && typeof conn === 'object') {
    const c = conn as Record<string, unknown>;
    if (typeof c.totalConnections === 'number') {
      cards.push({ label: 'WS connections', value: String(c.totalConnections), hint: 'from gateway snapshot' });
    }
  }
  return cards;
}

export function stockStatsExtraRows(data: unknown): KvRow[] {
  if (!data || typeof data !== 'object') return [];
  const o = data as Record<string, unknown>;
  const rows: KvRow[] = [];
  if (o.batchStats && typeof o.batchStats === 'object') {
    rows.push(...flattenObject(o.batchStats, 'batch', 2));
  }
  if (o.connectionStats && typeof o.connectionStats === 'object') {
    rows.push(...flattenObject(o.connectionStats, 'connections', 2));
  }
  return rows;
}

export function adminProviderLabel(data: unknown): string {
  if (!data || typeof data !== 'object') return '—';
  const p = (data as Record<string, unknown>).provider;
  return p == null ? '—' : String(p);
}

export function streamSummaryRows(data: unknown): KvRow[] {
  if (!data || typeof data !== 'object') return flattenObject(data, '', 2);
  const o = data as Record<string, unknown>;
  const rows: KvRow[] = [];
  if (o.isStreaming !== undefined) rows.push({ label: 'Streaming', value: o.isStreaming ? 'Yes' : 'No' });
  if (o.providerName !== undefined) rows.push({ label: 'Provider', value: String(o.providerName) });
  return rows.length ? rows : flattenObject(data, '', 2);
}

export function wsStatusSummaryRows(data: unknown): KvRow[] {
  if (!data || typeof data !== 'object') return [];
  const o = data as Record<string, unknown>;
  const rows: KvRow[] = [];
  if (o.namespace !== undefined) rows.push({ label: 'Namespace', value: String(o.namespace) });
  if (o.protocol_version !== undefined) rows.push({ label: 'Protocol', value: String(o.protocol_version) });
  if (typeof o.connections === 'number') rows.push({ label: 'Connections', value: String(o.connections) });
  if (o.redis_ok !== undefined) rows.push({ label: 'Redis', value: o.redis_ok ? 'OK' : 'Issue' });
  if (Array.isArray(o.subscriptions)) rows.push({ label: 'Subscription groups', value: String(o.subscriptions.length) });
  return rows;
}

/** Compact labels for the terminal ticker (IST-oriented copy handled by caller). */
export function buildTickerSegments(input: {
  health: unknown;
  mdHealth: unknown;
  stats: unknown;
  globalProv: unknown;
  stream: unknown;
  ws: unknown;
  hasAdminToken: boolean;
}): string[] {
  const parts: string[] = [];
  const hs = healthOverallStatus(input.health);
  parts.push(hs === 'ok' ? 'HEALTH OK' : hs === 'bad' ? 'HEALTH FAIL' : 'HEALTH WARN');

  if (input.mdHealth && typeof input.mdHealth === 'object') {
    const md = input.mdHealth as Record<string, unknown>;
    if (md.provider != null) parts.push(`MD provider ${String(md.provider)}`);
  }

  if (input.stats && typeof input.stats === 'object') {
    const s = input.stats as Record<string, unknown>;
    if (typeof s.instruments === 'number') parts.push(`Inst ${s.instruments}`);
    if (typeof s.activeSubscriptions === 'number') parts.push(`Subs ${s.activeSubscriptions}`);
  }

  if (!input.hasAdminToken) {
    parts.push('ADMIN token unset — live provider stream gated');
    return parts;
  }

  parts.push(`Global ${adminProviderLabel(input.globalProv)}`);

  if (input.stream && typeof input.stream === 'object') {
    const st = input.stream as Record<string, unknown>;
    const on = st.isStreaming === true;
    parts.push(on ? 'STREAM ON' : 'STREAM OFF');
  }

  if (input.ws && typeof input.ws === 'object') {
    const w = input.ws as Record<string, unknown>;
    if (typeof w.connections === 'number') parts.push(`WS ${w.connections} conn`);
  }

  return parts;
}
