/**
 * @file refresh-interval-context.ts
 * @module admin-dashboard
 * @description React context object for global admin dashboard polling interval.
 * @author BharatERP
 * @created 2026-03-28
 */

import { createContext } from 'react';
import type { PollPresetId } from '../lib/poll-presets';

export interface RefreshIntervalContextValue {
  presetId: PollPresetId;
  setPresetId: (id: PollPresetId) => void;
  refetchInterval: number | false;
  lastFetchLatencyMs: number | null;
  recordFetchLatency: (ms: number) => void;
}

export const RefreshIntervalContext =
  createContext<RefreshIntervalContextValue | null>(null);
