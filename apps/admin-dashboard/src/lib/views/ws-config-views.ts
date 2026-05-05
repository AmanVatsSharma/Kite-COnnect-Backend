/**
 * @file ws-config-views.ts
 * @module admin-dashboard
 * @description Map WS admin config payloads to KeyValueGrid rows.
 */

import { flattenObject, type KvRow } from './flatten';

export function wsConfigToRows(data: unknown): KvRow[] {
  if (!data || typeof data !== 'object') return [];
  const o = data as Record<string, unknown>;
  const rows: KvRow[] = [];
  const rl = o.rate_limits;
  if (rl && typeof rl === 'object') {
    const r = rl as Record<string, unknown>;
    if (r.subscribe_rps !== undefined)
      rows.push({ label: 'subscribe_rps', value: String(r.subscribe_rps) });
    if (r.unsubscribe_rps !== undefined)
      rows.push({ label: 'unsubscribe_rps', value: String(r.unsubscribe_rps) });
    if (r.mode_rps !== undefined)
      rows.push({ label: 'mode_rps', value: String(r.mode_rps) });
  }
  if (typeof o.maxSubscriptionsPerSocket === 'number') {
    rows.push({
      label: 'maxSubscriptionsPerSocket',
      value: String(o.maxSubscriptionsPerSocket),
    });
  }
  if (Array.isArray(o.entitlement_defaults)) {
    rows.push({
      label: 'entitlement_defaults',
      value: o.entitlement_defaults.join(', '),
    });
  }
  return rows.length ? rows : flattenObject(data, '', 2);
}
