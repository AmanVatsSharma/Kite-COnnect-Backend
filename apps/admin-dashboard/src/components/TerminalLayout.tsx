/**
 * @file TerminalLayout.tsx
 * @module admin-dashboard
 * @description Bloomberg-style shell: ticker, icon rail, status bar, command palette (⌘K).
 * @author BharatERP
 * @created 2026-03-28
 */

import { NavLink, Outlet } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import { getAdminToken } from '../lib/api-client';
import { useAuthAlert } from '../hooks/useAuthAlert';
import type { PollPresetId } from '../lib/poll-presets';
import { POLL_PRESET_ORDER } from '../lib/poll-presets';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
import { TickerStrip } from './TickerStrip';
import { CommandPalette } from './CommandPalette';

const navItems = [
  { to: '/', label: 'Overview', abbr: 'Ovw' },
  { to: '/workspace', label: 'Workspace', abbr: 'Wsp' },
  { to: '/keys', label: 'API keys', abbr: 'Key' },
  { to: '/provider', label: 'Provider', abbr: 'Prv' },
  { to: '/ws', label: 'WS admin', abbr: 'WS' },
  { to: '/abuse', label: 'Abuse', abbr: 'Abu' },
  { to: '/audit', label: 'Audit', abbr: 'Aud' },
  { to: '/auth', label: 'Auth', abbr: 'Ath' },
  { to: '/console', label: 'Console', abbr: 'Con' },
  { to: '/settings', label: 'Settings', abbr: 'Set' },
];

function formatIstTime(d: Date): string {
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function StatusBar() {
  const { presetId, setPresetId, lastFetchLatencyMs, refetchInterval } = useRefreshInterval();
  const [clock, setClock] = useState(() => formatIstTime(new Date()));

  useEffect(() => {
    const id = window.setInterval(() => setClock(formatIstTime(new Date())), 1000);
    return () => window.clearInterval(id);
  }, []);

  const tokenHint = getAdminToken() ? 'token set' : 'no token';

  return (
    <footer className="terminal-statusbar">
      <span className="terminal-mono" title="Asia/Kolkata">
        IST {clock}
      </span>
      <span className="terminal-statusbar__sep" aria-hidden>
        │
      </span>
      <label className="terminal-statusbar__poll">
        <span className="muted">Poll</span>
        <select
          value={presetId}
          onChange={(e) => setPresetId(e.target.value as PollPresetId)}
          aria-label="Polling interval"
        >
          {POLL_PRESET_ORDER.map((id) => (
            <option key={id} value={id}>
              {id === 'pause' ? 'Paused' : id}
            </option>
          ))}
        </select>
      </label>
      <span className="terminal-statusbar__sep" aria-hidden>
        │
      </span>
      <span className="muted" title="Last measured client round-trip for a live query">
        RT {lastFetchLatencyMs != null ? `${lastFetchLatencyMs}ms` : '—'}
      </span>
      <span className="terminal-statusbar__sep" aria-hidden>
        │
      </span>
      <span className="muted" title="Active refetch interval">
        {refetchInterval === false ? 'manual refresh' : `${Number(refetchInterval) / 1000}s`}
      </span>
      <span className="terminal-statusbar__sep" aria-hidden>
        │
      </span>
      <span className={`terminal-statusbar__token ${getAdminToken() ? 'ok' : 'warn'}`}>{tokenHint}</span>
      <span className="terminal-statusbar__sep" aria-hidden>
        │
      </span>
      <span className="muted">⌘K palette</span>
      <a className="terminal-statusbar__legacy" href={`${import.meta.env.BASE_URL}legacy-dashboard.html`}>
        Legacy UI
      </a>
    </footer>
  );
}

export function TerminalLayout() {
  const hasToken = !!getAdminToken();
  const { unauthorized, setUnauthorized } = useAuthAlert();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="terminal-app">
      <CommandPalette open={paletteOpen} onClose={closePalette} />
      <TickerStrip />
      <div className="terminal-body">
        <aside className="terminal-rail" aria-label="Primary navigation">
          {navItems.map(({ to, label, abbr }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `terminal-rail__link ${isActive ? 'active' : ''}`}
              title={label}
            >
              <span className="terminal-rail__abbr">{abbr}</span>
            </NavLink>
          ))}
          <button type="button" className="terminal-rail__palette" onClick={openPalette} title="Command palette (⌘K)">
            ⌘K
          </button>
        </aside>
        <div className="terminal-main">
          {unauthorized && (
            <div
              className="card terminal-alert"
              style={{
                marginTop: 12,
                borderColor: 'var(--bad)',
                background: 'rgba(255, 107, 107, 0.08)',
              }}
            >
              <strong>401 Unauthorized</strong>
              <p className="muted" style={{ margin: '8px 0' }}>
                Admin token missing or wrong. Update it under{' '}
                <NavLink to="/settings" onClick={() => setUnauthorized(false)}>
                  Settings
                </NavLink>
                .
              </p>
              <button type="button" className="btn btn-ghost" onClick={() => setUnauthorized(false)}>
                Dismiss
              </button>
            </div>
          )}
          {!hasToken && (
            <p className="err terminal-token-banner">
              Set your admin token under <NavLink to="/settings">Settings</NavLink> to enable protected actions and live
              admin panels.
            </p>
          )}
          <Outlet />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
