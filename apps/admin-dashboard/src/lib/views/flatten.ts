/**
 * @file flatten.ts
 * @module admin-dashboard
 * @description Safely turn nested objects into label/value rows for dashboards (depth-limited).
 */

export type KvRow = { label: string; value: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Flatten object keys for display; skips functions; depth 0 = one level only. */
export function flattenObject(
  obj: unknown,
  prefix = '',
  maxDepth = 2,
  depth = 0,
): KvRow[] {
  if (obj === null || obj === undefined)
    return [{ label: prefix || 'value', value: '—' }];
  if (
    typeof obj === 'string' ||
    typeof obj === 'number' ||
    typeof obj === 'boolean'
  ) {
    return [{ label: prefix || 'value', value: String(obj) }];
  }
  if (Array.isArray(obj)) {
    return [{ label: prefix || 'array', value: `[${obj.length} items]` }];
  }
  if (!isPlainObject(obj)) {
    return [{ label: prefix || 'value', value: String(obj) }];
  }
  const rows: KvRow[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (depth >= maxDepth) {
      rows.push({
        label: key,
        value: typeof v === 'object' ? JSON.stringify(v) : String(v),
      });
      continue;
    }
    if (v === null || v === undefined) {
      rows.push({ label: key, value: '—' });
    } else if (
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean'
    ) {
      rows.push({ label: key, value: String(v) });
    } else if (Array.isArray(v)) {
      rows.push({ label: key, value: `[${v.length} items]` });
    } else if (isPlainObject(v)) {
      rows.push(...flattenObject(v, key, maxDepth, depth + 1));
    } else {
      rows.push({ label: key, value: String(v) });
    }
  }
  return rows;
}
