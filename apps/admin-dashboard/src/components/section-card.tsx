/**
 * @file section-card.tsx
 * @module admin-dashboard
 * @description Card shell with optional collapsible body for dense admin sections.
 */

import type { ReactNode } from 'react';

export function SectionCard({
  title,
  defaultOpen = true,
  collapsible = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  collapsible?: boolean;
  children: ReactNode;
}) {
  if (!collapsible) {
    return (
      <section className="card section-card">
        <h2>{title}</h2>
        {children}
      </section>
    );
  }
  return (
    <details className="card section-card section-card--collapsible" open={defaultOpen}>
      <summary className="section-card__summary">{title}</summary>
      <div className="section-card__body">{children}</div>
    </details>
  );
}
