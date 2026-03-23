/**
 * @file StatusBadge.tsx
 * @module admin-dashboard
 * @description Semantic status pill for health and boolean states.
 */

import type { ReactNode } from 'react';

export type StatusVariant = 'ok' | 'warn' | 'bad' | 'neutral';

const variantClass: Record<StatusVariant, string> = {
  ok: 'pill ok',
  warn: 'pill warn',
  bad: 'pill bad',
  neutral: 'pill neutral',
};

export function StatusBadge({ variant, children }: { variant: StatusVariant; children: ReactNode }) {
  return <span className={variantClass[variant]}>{children}</span>;
}
