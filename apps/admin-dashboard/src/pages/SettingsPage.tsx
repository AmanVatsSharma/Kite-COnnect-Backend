/**
 * @file SettingsPage.tsx
 * @module admin-dashboard
 * @description Admin token management and global WS tick throttle settings.
 * @author BharatERP
 * @updated 2026-05-08
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getAdminToken, setAdminToken } from '../lib/api-client';
import { useAuthAlert } from '../hooks/useAuthAlert';
import * as admin from '../lib/admin-api';

const THROTTLE_PRESETS = [
  { label: 'Off', ms: 0 },
  { label: '250ms', ms: 250 },
  { label: '500ms', ms: 500 },
  { label: '1s', ms: 1000 },
  { label: '2s', ms: 2000 },
];

export function SettingsPage() {
  const [v, setV] = useState(() => getAdminToken() ?? '');
  const { setUnauthorized } = useAuthAlert();
  const qc = useQueryClient();
  const hasToken = !!getAdminToken();
  const token = getAdminToken();

  const [throttleInput, setThrottleInput] = useState('');

  const throttleQuery = useQuery({
    queryKey: ['global-tick-throttle'],
    queryFn: admin.getTickThrottle,
    enabled: !!token,
  });

  const setThrottle = useMutation({
    mutationFn: (ms: number) => admin.setTickThrottle(ms),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['global-tick-throttle'] }),
  });

  function applyThrottle(ms: number) {
    setThrottle.mutate(ms);
    setThrottleInput(String(ms));
  }

  function save() {
    setAdminToken(v.trim() || null);
    qc.clear();
    setUnauthorized(false);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div className="page-head">
        <h1>SETTINGS</h1>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className={`dot ${hasToken ? 'dot--live' : 'dot--off'}`} />
          <span style={{ fontSize: 11, fontWeight: 700, color: hasToken ? 'var(--ok)' : 'var(--muted)' }}>
            {hasToken ? 'TOKEN ACTIVE' : 'NO TOKEN'}
          </span>
        </span>
      </div>

      <div className="panel" style={{ maxWidth: 560 }}>
        <div className="panel__head">
          <span className="panel__title">ADMIN TOKEN</span>
          {hasToken && <span className="cc-chip cc-chip--ok" style={{ fontSize: 9 }}>ACTIVE</span>}
        </div>
        <div className="panel__body">
          <p style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.5 }}>
            Stored in <code style={{ fontSize: 10 }}>sessionStorage</code> as{' '}
            <code style={{ fontSize: 10 }}>x-admin-token</code>. Sent on all{' '}
            <code style={{ fontSize: 10 }}>/api/admin/*</code> requests. Cleared on tab close.
          </p>

          <label style={{ fontSize: 10, marginBottom: 3, display: 'block', color: 'var(--muted)' }}>TOKEN VALUE</label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            <input
              type="password"
              autoComplete="off"
              value={v}
              onChange={(e) => setV(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              placeholder="Paste ADMIN_TOKEN value"
              style={{ flex: 1, fontSize: 11, padding: '4px 8px' }}
            />
            <button type="button" className="btn-xs btn-xs--ok" onClick={save}>
              Save
            </button>
            <button
              type="button"
              className="btn-xs btn-xs--danger"
              onClick={() => {
                setAdminToken(null);
                setV('');
                setUnauthorized(false);
              }}
            >
              Clear
            </button>
          </div>

          <div style={{ fontSize: 10, display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className={`dot ${hasToken ? 'dot--live' : 'dot--off'}`} />
            <span style={{ color: hasToken ? 'var(--ok)' : 'var(--muted)' }}>
              {hasToken
                ? 'Token is active — protected admin endpoints are accessible.'
                : 'No token set — admin endpoints will return 401.'}
            </span>
          </div>
        </div>
      </div>

      <div className="panel" style={{ maxWidth: 560 }}>
        <div className="panel__head">
          <span className="panel__title">TICK THROTTLE</span>
          {throttleQuery.data && (
            <span className="cc-chip cc-chip--ok" style={{ fontSize: 9 }}>
              {throttleQuery.data.ms === 0 ? 'OFF' : `${throttleQuery.data.ms}ms`}
            </span>
          )}
        </div>
        <div className="panel__body">
          <p style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.5 }}>
            Global WS tick broadcast throttle. Reduces server load by coalescing rapid upstream ticks
            into at most one delivery per window. <code style={{ fontSize: 10 }}>0</code> = off (every tick forwarded).
            Per-key overrides can be set on each API key's Limits tab.
          </p>

          <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 6 }}>
            CURRENT:{' '}
            <strong style={{ color: 'var(--fg)' }}>
              {throttleQuery.isLoading ? '…' : throttleQuery.data?.ms === 0 ? 'Off' : `${throttleQuery.data?.ms ?? '—'}ms`}
            </strong>
          </div>

          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
            {THROTTLE_PRESETS.map((p) => (
              <button
                key={p.ms}
                type="button"
                className="btn-xs"
                style={{ opacity: throttleQuery.data?.ms === p.ms ? 1 : 0.6 }}
                onClick={() => applyThrottle(p.ms)}
                disabled={setThrottle.isPending}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="number"
              min={0}
              step={100}
              value={throttleInput}
              onChange={(e) => setThrottleInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyThrottle(Number(throttleInput))}
              placeholder="Custom ms"
              style={{ width: 100, fontSize: 11, padding: '4px 8px' }}
            />
            <button
              type="button"
              className="btn-xs btn-xs--ok"
              disabled={setThrottle.isPending || throttleInput === ''}
              onClick={() => applyThrottle(Number(throttleInput))}
            >
              {setThrottle.isPending ? 'Saving…' : 'Apply'}
            </button>
          </div>
          {setThrottle.isError && (
            <p className="err" style={{ fontSize: 10, marginTop: 4 }}>
              {(setThrottle.error as Error).message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
