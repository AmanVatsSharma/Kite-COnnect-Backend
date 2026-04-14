/**
 * @file toast.ts
 * @module admin-dashboard
 * @description Thin wrapper around sonner for consistent toast notifications.
 * @author BharatERP
 * @created 2026-04-14
 */
import { toast } from 'sonner';

export const notify = {
  ok: (msg: string) => toast.success(msg),
  warn: (msg: string) => toast.warning(msg),
  error: (msg: string, opts?: { duration?: number }) => toast.error(msg, { duration: opts?.duration ?? 8000 }),
  info: (msg: string) => toast(msg),
};
