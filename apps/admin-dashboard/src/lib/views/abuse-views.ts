/**
 * @file abuse-views.ts
 * @module admin-dashboard
 * @description Helpers for abuse flag list and detail presentation.
 */

import type { AbuseFlag } from '../types';
import { flattenObject, type KvRow } from './flatten';

export function abuseRiskVariant(score: number): 'ok' | 'warn' | 'bad' {
  if (score >= 70) return 'bad';
  if (score >= 35) return 'warn';
  return 'ok';
}

export function abuseFlagDetailRows(flag: AbuseFlag): KvRow[] {
  const rows: KvRow[] = [
    { label: 'API key', value: flag.api_key },
    { label: 'Tenant', value: flag.tenant_id ?? '—' },
    { label: 'Risk score', value: String(flag.risk_score) },
    { label: 'Blocked', value: flag.blocked ? 'Yes' : 'No' },
  ];
  if (flag.reason_codes?.length) {
    rows.push({ label: 'Reason codes', value: flag.reason_codes.join(', ') });
  }
  if (flag.detected_at)
    rows.push({ label: 'Detected', value: flag.detected_at });
  if (flag.last_seen_at)
    rows.push({ label: 'Last seen', value: flag.last_seen_at });
  return rows;
}

export function abuseFlagFromUnknown(data: unknown): KvRow[] {
  if (!data || typeof data !== 'object') return [];
  const o = data as Record<string, unknown>;
  if (
    typeof o.api_key === 'string' &&
    typeof o.risk_score === 'number' &&
    typeof o.blocked === 'boolean'
  ) {
    const flag: AbuseFlag = {
      api_key: o.api_key,
      risk_score: o.risk_score,
      blocked: o.blocked,
      tenant_id:
        typeof o.tenant_id === 'string' || o.tenant_id === null
          ? (o.tenant_id as string | null)
          : undefined,
      reason_codes: Array.isArray(o.reason_codes)
        ? o.reason_codes.filter((x): x is string => typeof x === 'string')
        : undefined,
      detected_at:
        typeof o.detected_at === 'string' ? o.detected_at : undefined,
      last_seen_at:
        typeof o.last_seen_at === 'string' ? o.last_seen_at : undefined,
    };
    return abuseFlagDetailRows(flag);
  }
  return flattenObject(data, '', 3);
}
