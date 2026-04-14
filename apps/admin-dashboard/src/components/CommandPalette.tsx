/**
 * @file CommandPalette.tsx
 * @module admin-dashboard
 * @description Keyboard command palette: route jumps, refetch all queries, open settings, quick actions.
 * @author BharatERP
 * @created 2026-03-28
 * @updated 2026-04-14 — Phase 3: added action commands (restart ticker, sync, flush, provider switch)
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as admin from '../lib/admin-api';
import * as falcon from '../lib/falcon-api';
import { notify } from '../lib/toast';

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
};

type Cmd = { id: string; label: string; detail?: string; category?: 'nav' | 'action'; action: () => void };

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  if (!open) return null;
  return <CommandPaletteMounted onClose={onClose} />;
}

function CommandPaletteMounted({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');

  const commands = useMemo<Cmd[]>(
    () => [
      {
        id: 'overview',
        label: 'Go to Overview',
        detail: '/',
        action: () => navigate('/'),
      },
      {
        id: 'workspace',
        label: 'Go to Workspace',
        detail: '/workspace',
        action: () => navigate('/workspace'),
      },
      {
        id: 'keys',
        label: 'Go to API keys',
        detail: '/keys',
        action: () => navigate('/keys'),
      },
      {
        id: 'provider',
        label: 'Go to Provider & stream',
        detail: '/provider',
        action: () => navigate('/provider'),
      },
      {
        id: 'ws',
        label: 'Go to WebSocket admin',
        detail: '/ws',
        action: () => navigate('/ws'),
      },
      {
        id: 'abuse',
        label: 'Go to Abuse',
        detail: '/abuse',
        action: () => navigate('/abuse'),
      },
      {
        id: 'audit',
        label: 'Go to Audit & debug',
        detail: '/audit',
        action: () => navigate('/audit'),
      },
      {
        id: 'auth',
        label: 'Go to Auth',
        detail: '/auth',
        action: () => navigate('/auth'),
      },
      {
        id: 'console',
        label: 'Go to API console',
        detail: '/console',
        action: () => navigate('/console'),
      },
      {
        id: 'settings',
        label: 'Go to Settings',
        detail: '/settings',
        action: () => navigate('/settings'),
      },
      {
        id: 'refetch',
        label: 'Refetch all data',
        detail: 'Invalidate React Query cache',
        action: () => {
          void queryClient.invalidateQueries();
        },
      },
      // ── Actions ──────────────────────────────────────────────
      {
        id: 'restart-ticker',
        label: '⟳ Restart Kite Ticker',
        detail: 'POST /admin/falcon/ticker/restart',
        category: 'action',
        action: () => {
          notify.info('Restarting Kite ticker…');
          falcon.postFalconTickerRestart()
            .then(() => { notify.ok('Ticker restarted'); void queryClient.invalidateQueries({ queryKey: ['admin-debug-falcon'] }); })
            .catch((e: Error) => notify.error(`Restart failed: ${e.message}`));
        },
      },
      {
        id: 'sync-instruments',
        label: '↓ Sync Falcon Instruments',
        detail: 'POST /admin/falcon/instruments/sync',
        category: 'action',
        action: () => {
          notify.info('Syncing instruments…');
          falcon.syncFalconInstruments()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .then((d: any) => { notify.ok(`Synced ${d?.synced ?? '?'} instruments`); void queryClient.invalidateQueries({ queryKey: ['falcon-stats'] }); })
            .catch((e: Error) => notify.error(`Sync failed: ${e.message}`));
        },
      },
      {
        id: 'flush-options',
        label: '✕ Flush Options Cache',
        detail: 'DELETE /admin/falcon/cache/flush {type:options}',
        category: 'action',
        action: () => {
          falcon.flushFalconCache({ type: 'options' })
            .then(() => notify.ok('Options cache flushed'))
            .catch((e: Error) => notify.error(`Flush failed: ${e.message}`));
        },
      },
      {
        id: 'flush-ltp',
        label: '✕ Flush LTP Cache',
        detail: 'DELETE /admin/falcon/cache/flush {type:ltp}',
        category: 'action',
        action: () => {
          falcon.flushFalconCache({ type: 'ltp' })
            .then(() => notify.ok('LTP cache flushed'))
            .catch((e: Error) => notify.error(`Flush failed: ${e.message}`));
        },
      },
      {
        id: 'switch-kite',
        label: '⚡ Switch Provider → Kite',
        detail: 'POST /admin/provider/global {provider:kite}',
        category: 'action',
        action: () => {
          admin.setGlobalProvider('kite')
            .then(() => { notify.ok('Provider switched to Kite'); void queryClient.invalidateQueries({ queryKey: ['admin-global-provider'] }); })
            .catch((e: Error) => notify.error(`Switch failed: ${e.message}`));
        },
      },
      {
        id: 'switch-vortex',
        label: '⚡ Switch Provider → Vortex',
        detail: 'POST /admin/provider/global {provider:vortex}',
        category: 'action',
        action: () => {
          admin.setGlobalProvider('vortex')
            .then(() => { notify.ok('Provider switched to Vortex'); void queryClient.invalidateQueries({ queryKey: ['admin-global-provider'] }); })
            .catch((e: Error) => notify.error(`Switch failed: ${e.message}`));
        },
      },
      {
        id: 'start-stream',
        label: '▶ Start Stream',
        detail: 'POST /admin/provider/stream/start',
        category: 'action',
        action: () => {
          admin.startStream()
            .then(() => { notify.ok('Stream started'); void queryClient.invalidateQueries({ queryKey: ['admin-stream-status'] }); })
            .catch((e: Error) => notify.error(`Start failed: ${e.message}`));
        },
      },
      {
        id: 'stop-stream',
        label: '■ Stop Stream',
        detail: 'POST /admin/provider/stream/stop',
        category: 'action',
        action: () => {
          admin.stopStream()
            .then(() => { notify.ok('Stream stopped'); void queryClient.invalidateQueries({ queryKey: ['admin-stream-status'] }); })
            .catch((e: Error) => notify.error(`Stop failed: ${e.message}`));
        },
      },
    ],
    [navigate, queryClient],
  );

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(s) ||
        (c.detail && c.detail.toLowerCase().includes(s)) ||
        c.id.includes(s),
    );
  }, [commands, q]);

  const run = useCallback(
    (cmd: Cmd) => {
      cmd.action();
      onClose();
    },
    [onClose],
  );

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="cmd-palette-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="cmd-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmd-palette__input"
          placeholder="Type to filter commands…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <ul className="cmd-palette__list" role="listbox">
          {filtered.length === 0 ? (
            <li className="cmd-palette__empty muted">No matches</li>
          ) : (() => {
            const navItems = filtered.filter((c) => c.category !== 'action');
            const actionItems = filtered.filter((c) => c.category === 'action');
            return (
              <>
                {navItems.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="cmd-palette__item" onClick={() => run(c)}>
                      <span>{c.label}</span>
                      {c.detail ? <span className="cmd-palette__detail muted">{c.detail}</span> : null}
                    </button>
                  </li>
                ))}
                {actionItems.length > 0 && navItems.length > 0 && (
                  <li aria-hidden style={{ padding: '4px 12px', fontSize: 9, color: 'var(--muted)', letterSpacing: '0.1em', userSelect: 'none' }}>
                    — ACTIONS —
                  </li>
                )}
                {actionItems.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="cmd-palette__item cmd-palette__item--action" onClick={() => run(c)}>
                      <span>{c.label}</span>
                      {c.detail ? <span className="cmd-palette__detail muted">{c.detail}</span> : null}
                    </button>
                  </li>
                ))}
              </>
            );
          })()}
        </ul>
        <p className="cmd-palette__hint muted">Esc close · Click outside to dismiss</p>
      </div>
    </div>
  );
}
