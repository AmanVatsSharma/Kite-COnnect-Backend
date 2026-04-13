/**
 * @file useLiveAdminMetrics.ts
 * @module admin-dashboard
 * @description Shared live queries for overview, ticker, and workspace widgets (single cache per key).
 * @author BharatERP
 * @created 2026-03-28
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useCallback } from 'react';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import * as pub from '../lib/public-api';
import { useRefreshInterval } from './useRefreshInterval';

function useTimedFn<T>(recordLatency: (ms: number) => void, fn: () => Promise<T>) {
  return useCallback(async () => {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      recordLatency(Math.round(performance.now() - t0));
    }
  }, [fn, recordLatency]);
}

export interface LiveAdminMetrics {
  token: string | null;
  health: UseQueryResult<Awaited<ReturnType<typeof pub.getHealth>>>;
  mdHealth: UseQueryResult<Awaited<ReturnType<typeof pub.getMarketDataHealth>>>;
  stats: UseQueryResult<Awaited<ReturnType<typeof pub.getStockStats>>>;
  globalProv: UseQueryResult<Awaited<ReturnType<typeof admin.getGlobalProvider>>>;
  stream: UseQueryResult<Awaited<ReturnType<typeof admin.getStreamStatus>>>;
  ws: UseQueryResult<Awaited<ReturnType<typeof admin.getWsStatus>>>;
  refetchInterval: number | false;
}

/**
 * Subscribes to the same query keys as Overview; safe to call from multiple components (shared cache).
 */
export function useLiveAdminMetrics(): LiveAdminMetrics {
  const { refetchInterval, recordFetchLatency } = useRefreshInterval();
  const token = getAdminToken();

  const qHealth = useTimedFn(recordFetchLatency, pub.getHealth);
  const qMd = useTimedFn(recordFetchLatency, pub.getMarketDataHealth);
  const qStats = useTimedFn(recordFetchLatency, pub.getStockStats);
  const qGlob = useTimedFn(recordFetchLatency, admin.getGlobalProvider);
  const qStream = useTimedFn(recordFetchLatency, admin.getStreamStatus);
  const qWs = useTimedFn(recordFetchLatency, admin.getWsStatus);

  const health = useQuery({
    queryKey: ['health'],
    queryFn: qHealth,
    refetchInterval,
  });

  const mdHealth = useQuery({
    queryKey: ['health-md'],
    queryFn: qMd,
    refetchInterval,
  });

  const stats = useQuery({
    queryKey: ['stock-stats'],
    queryFn: qStats,
    refetchInterval,
  });

  const globalProv = useQuery({
    queryKey: ['admin-global-provider'],
    queryFn: qGlob,
    enabled: !!token,
    refetchInterval,
  });

  const stream = useQuery({
    queryKey: ['admin-stream-status'],
    queryFn: qStream,
    enabled: !!token,
    refetchInterval,
  });

  const ws = useQuery({
    queryKey: ['admin-ws-status'],
    queryFn: qWs,
    enabled: !!token,
    refetchInterval,
  });

  return {
    token,
    health,
    mdHealth,
    stats,
    globalProv,
    stream,
    ws,
    refetchInterval,
  };
}
