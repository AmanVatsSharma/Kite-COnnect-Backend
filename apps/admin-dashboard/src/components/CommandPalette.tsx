/**
 * @file CommandPalette.tsx
 * @module admin-dashboard
 * @description Keyboard command palette: route jumps, refetch all queries, open settings.
 * @author BharatERP
 * @created 2026-03-28
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
};

type Cmd = { id: string; label: string; detail?: string; action: () => void };

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
          ) : (
            filtered.map((c) => (
              <li key={c.id}>
                <button type="button" className="cmd-palette__item" onClick={() => run(c)}>
                  <span>{c.label}</span>
                  {c.detail ? <span className="cmd-palette__detail muted">{c.detail}</span> : null}
                </button>
              </li>
            ))
          )}
        </ul>
        <p className="cmd-palette__hint muted">Esc close · Click outside to dismiss</p>
      </div>
    </div>
  );
}
