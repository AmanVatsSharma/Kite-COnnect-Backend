/**
 * @file logger.ts
 * @module admin-dashboard
 * @description Dev-only debug helper; production paths avoid noisy console output.
 * @author BharatERP
 * @created 2026-03-28
 */

const isDev = import.meta.env.DEV;

export const adminLogger = {
  debug: (...args: unknown[]) => {
    if (isDev) {
      console.debug('[admin-dashboard]', ...args);
    }
  },
};
