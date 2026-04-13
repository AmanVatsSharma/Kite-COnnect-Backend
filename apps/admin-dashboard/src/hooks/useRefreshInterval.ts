/**
 * @file useRefreshInterval.ts
 * @module admin-dashboard
 * @description Consumes RefreshIntervalContext for TanStack Query refetchInterval wiring.
 * @author BharatERP
 * @created 2026-03-28
 */

import { useContext } from 'react';
import { RefreshIntervalContext, type RefreshIntervalContextValue } from '../contexts/refresh-interval-context';

export function useRefreshInterval(): RefreshIntervalContextValue {
  const ctx = useContext(RefreshIntervalContext);
  if (!ctx) {
    throw new Error('useRefreshInterval must be used within RefreshIntervalProvider');
  }
  return ctx;
}

/** Safe when provider may be absent (tests); defaults to 5s polling. */
export function useRefreshIntervalOptional(): RefreshIntervalContextValue {
  const ctx = useContext(RefreshIntervalContext);
  if (ctx) return ctx;
  return {
    presetId: '5s',
    setPresetId: () => {},
    refetchInterval: 5000,
    lastFetchLatencyMs: null,
    recordFetchLatency: () => {},
  };
}
