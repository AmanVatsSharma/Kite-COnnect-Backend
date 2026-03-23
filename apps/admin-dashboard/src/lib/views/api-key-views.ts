/**
 * @file api-key-views.ts
 * @module admin-dashboard
 * @description Normalize admin API key detail payloads for KeyValueGrid.
 */

import { flattenObject, type KvRow } from './flatten';

export function limitsToRows(data: unknown): KvRow[] {
  if (!data || typeof data !== 'object') return [];
  const o = data as Record<string, unknown>;
  const rows: KvRow[] = [];
  if (o.key !== undefined) rows.push({ label: 'Key', value: String(o.key) });
  if (o.tenant_id !== undefined) rows.push({ label: 'Tenant', value: String(o.tenant_id) });
  if (o.is_active !== undefined) rows.push({ label: 'Active', value: o.is_active ? 'Yes' : 'No' });
  const lim = o.limits;
  if (lim && typeof lim === 'object') {
    for (const [k, v] of Object.entries(lim as Record<string, unknown>)) {
      if (Array.isArray(v)) rows.push({ label: k, value: v.join(', ') });
      else rows.push({ label: k, value: v == null ? '—' : String(v) });
    }
  }
  return rows.length ? rows : flattenObject(data, '', 2);
}

export function usageBundleToRows(data: unknown): KvRow[] {
  if (!data || typeof data !== 'object') return [];
  const o = data as Record<string, unknown>;
  const rows: KvRow[] = [];
  if (o.key !== undefined) rows.push({ label: 'Key', value: String(o.key) });
  if (o.tenant_id !== undefined) rows.push({ label: 'Tenant', value: String(o.tenant_id) });
  if (o.is_active !== undefined) rows.push({ label: 'Active', value: o.is_active ? 'Yes' : 'No' });
  if (o.limits && typeof o.limits === 'object') {
    rows.push({ label: 'Limits', value: '—' });
    rows.push(...flattenObject(o.limits, 'limits', 2));
  }
  if (o.usage !== undefined) {
    rows.push({ label: 'Usage', value: '—' });
    rows.push(...flattenObject(o.usage, 'usage', 3));
  }
  return rows.length ? rows : flattenObject(data, '', 3);
}
