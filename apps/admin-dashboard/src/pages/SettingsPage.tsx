/**
 * @file SettingsPage.tsx
 * @module admin-dashboard
 * @description Admin token management — compact terminal panel.
 * @author BharatERP
 * @updated 2026-04-14
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getAdminToken, setAdminToken } from '../lib/api-client';
import { useAuthAlert } from '../hooks/useAuthAlert';

export function SettingsPage() {
  const [v, setV] = useState(() => getAdminToken() ?? '');
  const { setUnauthorized } = useAuthAlert();
  const qc = useQueryClient();
  const hasToken = !!getAdminToken();

  function save() {
    setAdminToken(v.trim() || null);
    setUnauthorized(false);
    void qc.invalidateQueries();
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
    </div>
  );
}
