/**
 * @file KeyValueGrid.tsx
 * @module admin-dashboard
 * @description Two-column label / value layout for structured API data.
 */

import type { ReactNode } from 'react';

export type KeyValueRow = { label: string; value: ReactNode };

export function KeyValueGrid({ rows }: { rows: KeyValueRow[] }) {
  if (!rows.length) return <p className="muted">No fields to display.</p>;
  return (
    <dl className="kv-grid">
      {rows.map(({ label, value }, i) => (
        <div key={`${label}-${i}`} className="kv-grid__row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
