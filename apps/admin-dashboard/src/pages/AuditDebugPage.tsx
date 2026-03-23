/**
 * @file AuditDebugPage.tsx
 * @module admin-dashboard
 * @description Audit sampling and provider debug endpoints with labeled fields and raw JSON.
 */

import { useQuery } from '@tanstack/react-query';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import { ErrorInline } from '../components/ErrorInline';
import { KeyValueGrid } from '../components/KeyValueGrid';
import { RawJsonDetails } from '../components/RawJsonDetails';
import { SectionCard } from '../components/section-card';
import { auditConfigToRows } from '../lib/views/audit-views';
import { flattenObject } from '../lib/views/flatten';

export function AuditDebugPage() {
  const token = getAdminToken();

  const audit = useQuery({
    queryKey: ['admin-audit-config'],
    queryFn: admin.getAuditConfig,
    enabled: !!token,
  });

  const falcon = useQuery({
    queryKey: ['admin-debug-falcon'],
    queryFn: admin.getKiteDebug,
    enabled: !!token,
    refetchInterval: 10000,
  });

  const vayu = useQuery({
    queryKey: ['admin-debug-vayu'],
    queryFn: admin.getVortexDebug,
    enabled: !!token,
    refetchInterval: 10000,
  });

  if (!token) {
    return (
      <section className="card">
        <p className="err">Add an admin token in Settings.</p>
      </section>
    );
  }

  return (
    <>
      <section className="card">
        <h2>Audit sampling config</h2>
        <ErrorInline message={audit.isError ? (audit.error as Error).message : null} />
        {audit.data && (
          <>
            <KeyValueGrid rows={auditConfigToRows(audit.data).map((r) => ({ label: r.label, value: r.value }))} />
            <RawJsonDetails value={audit.data} summary="Technical details (raw JSON)" />
          </>
        )}
      </section>

      <SectionCard title="Falcon (Kite) debug" collapsible defaultOpen={false}>
        <ErrorInline message={falcon.isError ? (falcon.error as Error).message : null} />
        {falcon.data && (
          <div className="debug-kv">
            <KeyValueGrid rows={flattenObject(falcon.data, '', 3).map((r) => ({ label: r.label, value: r.value }))} />
            <RawJsonDetails value={falcon.data} summary="Technical details (raw JSON)" />
          </div>
        )}
      </SectionCard>

      <SectionCard title="Vayu (Vortex) debug" collapsible defaultOpen={false}>
        <ErrorInline message={vayu.isError ? (vayu.error as Error).message : null} />
        {vayu.data && (
          <div className="debug-kv">
            <KeyValueGrid rows={flattenObject(vayu.data, '', 3).map((r) => ({ label: r.label, value: r.value }))} />
            <RawJsonDetails value={vayu.data} summary="Technical details (raw JSON)" />
          </div>
        )}
      </SectionCard>
    </>
  );
}
