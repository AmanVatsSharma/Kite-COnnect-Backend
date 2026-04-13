/**
 * @file RefreshIntervalProvider.tsx
 * @module admin-dashboard
 * @description Provider for global poll interval and last observed-request latency.
 * @author BharatERP
 * @created 2026-03-28
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  PRESET_MS,
  persistPollPreset,
  readStoredPollPreset,
  type PollPresetId,
} from '../lib/poll-presets';
import { RefreshIntervalContext } from './refresh-interval-context';

export function RefreshIntervalProvider({ children }: { children: ReactNode }) {
  const [presetId, setPresetIdState] = useState<PollPresetId>(() => readStoredPollPreset());
  const [lastFetchLatencyMs, setLastFetchLatencyMs] = useState<number | null>(null);

  const setPresetId = useCallback((id: PollPresetId) => {
    setPresetIdState(id);
    persistPollPreset(id);
  }, []);

  const recordFetchLatency = useCallback((ms: number) => {
    setLastFetchLatencyMs(ms);
  }, []);

  const refetchInterval = PRESET_MS[presetId];

  const value = useMemo(
    () => ({
      presetId,
      setPresetId,
      refetchInterval,
      lastFetchLatencyMs,
      recordFetchLatency,
    }),
    [presetId, setPresetId, refetchInterval, lastFetchLatencyMs, recordFetchLatency],
  );

  return (
    <RefreshIntervalContext.Provider value={value}>{children}</RefreshIntervalContext.Provider>
  );
}
