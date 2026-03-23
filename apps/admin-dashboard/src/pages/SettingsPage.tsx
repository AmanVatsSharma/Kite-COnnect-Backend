import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getAdminToken, setAdminToken } from '../lib/api-client';
import { useAuthAlert } from '../hooks/useAuthAlert';

export function SettingsPage() {
  const [v, setV] = useState(() => getAdminToken() ?? '');
  const { setUnauthorized } = useAuthAlert();
  const qc = useQueryClient();

  return (
    <section className="card">
      <h2>Admin token</h2>
      <p className="muted">Stored in sessionStorage as <code>x-admin-token</code> for <code>/api/admin/*</code> calls.</p>
      <div className="row">
        <div style={{ flex: 2, minWidth: 240 }}>
          <label htmlFor="tok">Token</label>
          <input
            id="tok"
            type="password"
            autoComplete="off"
            value={v}
            onChange={(e) => setV(e.target.value)}
            placeholder="Paste ADMIN_TOKEN value"
          />
        </div>
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => {
          setAdminToken(v.trim() || null);
          setUnauthorized(false);
          void qc.invalidateQueries();
        }}
      >
        Save token
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        style={{ marginLeft: 8 }}
        onClick={() => {
          setAdminToken(null);
          setV('');
          setUnauthorized(false);
        }}
      >
        Clear
      </button>
    </section>
  );
}
