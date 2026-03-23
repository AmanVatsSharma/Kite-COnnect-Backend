/**
 * @file RawJsonDetails.tsx
 * @module admin-dashboard
 * @description Collapsible raw JSON for operators / support.
 */

import { JsonBlock } from './JsonBlock';

export function RawJsonDetails({
  value,
  summary = 'Technical details (raw JSON)',
}: {
  value: unknown;
  summary?: string;
}) {
  return (
    <details className="raw-json-details">
      <summary>{summary}</summary>
      <JsonBlock value={value} />
    </details>
  );
}
