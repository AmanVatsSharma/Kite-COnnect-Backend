/**
 * @file audit-views.ts
 * @module admin-dashboard
 * @description Map audit / debug admin payloads to KeyValueGrid rows.
 */

import { flattenObject, type KvRow } from './flatten';

export function auditConfigToRows(data: unknown): KvRow[] {
  if (!data || typeof data !== 'object') return [];
  const o = data as Record<string, unknown>;
  const rows: KvRow[] = [];
  if (typeof o.http_sample_rate === 'number') {
    rows.push({ label: 'http_sample_rate', value: String(o.http_sample_rate) });
  }
  if (typeof o.http_always_log_errors === 'boolean') {
    rows.push({ label: 'http_always_log_errors', value: o.http_always_log_errors ? 'Yes' : 'No' });
  }
  if (typeof o.ws_sub_sample_rate === 'number') {
    rows.push({ label: 'ws_sub_sample_rate', value: String(o.ws_sub_sample_rate) });
  }
  return rows.length ? rows : flattenObject(data, '', 2);
}
