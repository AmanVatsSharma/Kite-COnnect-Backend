/**
 * @file useSystemAlerts.ts
 * @module admin-dashboard
 * @description Polls Kite debug status every 10s and fires toast notifications on state transitions.
 * Mount once inside TerminalLayout so alerts fire on any page.
 * @author BharatERP
 * @created 2026-04-14
 */
import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import { notify } from '../lib/toast';

interface KiteState {
  connected: boolean;
  degraded: boolean;
  lastErrorMsg: string | null;
}

export function useSystemAlerts() {
  const prevRef = useRef<KiteState | null>(null);
  const lastErrorRef = useRef<string | null>(null);

  useQuery({
    queryKey: ['system-alerts-kite'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: admin.getKiteDebug as () => Promise<any>,
    refetchInterval: 10_000,
    enabled: !!getAdminToken(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    select: (data: any) => {
      const cur: KiteState = {
        connected: !!data?.connected,
        degraded: !!data?.degraded,
        lastErrorMsg: data?.lastTickerError?.message ?? null,
      };
      const prev = prevRef.current;
      if (prev) {
        if (prev.connected && !cur.connected) {
          notify.error('Kite stream disconnected');
        } else if (!prev.connected && cur.connected) {
          notify.ok('Kite stream reconnected');
        }
        if (!prev.degraded && cur.degraded) {
          notify.warn('Kite connection degraded');
        }
        // Fire auth error toast once per unique error message
        const errMsg = cur.lastErrorMsg;
        if (errMsg && errMsg !== lastErrorRef.current) {
          const lower = errMsg.toLowerCase();
          if (
            lower.includes('token') ||
            lower.includes('auth') ||
            lower.includes('unauthorized') ||
            lower.includes('forbidden')
          ) {
            notify.error('Kite auth error — re-authenticate at /auth', {
              duration: 12000,
            });
            lastErrorRef.current = errMsg;
          }
        }
      }
      prevRef.current = cur;
      return data;
    },
  });
}
