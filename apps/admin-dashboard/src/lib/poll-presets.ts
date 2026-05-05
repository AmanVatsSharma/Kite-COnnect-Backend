/**
 * @file poll-presets.ts
 * @module admin-dashboard
 * @description Poll interval presets and localStorage persistence for live admin queries.
 * @author BharatERP
 * @created 2026-03-28
 */

export type PollPresetId = 'pause' | '1s' | '3s' | '5s' | '15s';

const STORAGE_KEY = 'admin_dashboard_poll_preset';

export const POLL_PRESET_ORDER: PollPresetId[] = [
  'pause',
  '1s',
  '3s',
  '5s',
  '15s',
];

export const PRESET_MS: Record<PollPresetId, number | false> = {
  pause: false,
  '1s': 1000,
  '3s': 3000,
  '5s': 5000,
  '15s': 15000,
};

export function readStoredPollPreset(): PollPresetId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) as PollPresetId | null;
    if (raw && raw in PRESET_MS) return raw;
  } catch {
    /* ignore */
  }
  return '5s';
}

export function persistPollPreset(id: PollPresetId) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}
