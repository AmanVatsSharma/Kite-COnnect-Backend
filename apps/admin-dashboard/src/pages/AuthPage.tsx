import { useState } from 'react';
import { apiFetch } from '../lib/api-client';
import { apiUrl } from '../lib/api-base';

export function AuthPage() {
  const [vortexAuth, setVortexAuth] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function startKite() {
    setMsg(null);
    try {
      const data = await apiFetch<{ url?: string }>('/api/auth/kite/login');
      if (data?.url) window.open(data.url, 'kite-auth', 'width=600,height=700');
      else setMsg('No URL in response');
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function completeVortex() {
    setMsg(null);
    if (!vortexAuth.trim()) {
      setMsg('Paste auth parameter');
      return;
    }
    try {
      const q = new URLSearchParams({ auth: vortexAuth.trim() });
      const data = await apiFetch<{ success?: boolean }>(`/api/auth/vortex/callback?${q}`);
      setMsg(data && typeof data === 'object' && 'success' in data ? JSON.stringify(data) : 'OK');
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <section className="card">
      <h2>Provider authentication</h2>
      <p className="muted">Opens OAuth / login flows against the same API base as this UI.</p>

      <h3 style={{ marginTop: 20 }}>Kite</h3>
      <button type="button" className="btn" onClick={startKite}>
        Start Kite OAuth (popup)
      </button>
      <p className="muted" style={{ marginTop: 8 }}>
        Or open{' '}
        <a href={apiUrl('/api/auth/kite/login')} target="_blank" rel="noreferrer">
          /api/auth/kite/login
        </a>
      </p>

      <h3 style={{ marginTop: 24 }}>Vortex</h3>
      <p className="muted">
        <a href={apiUrl('/api/auth/vortex/login')} target="_blank" rel="noreferrer">
          Open Vortex login
        </a>{' '}
        — then paste the <code>auth</code> query param from the callback URL.
      </p>
      <label htmlFor="va">Auth parameter</label>
      <textarea id="va" value={vortexAuth} onChange={(e) => setVortexAuth(e.target.value)} placeholder="auth=..." />
      <div style={{ marginTop: 10 }}>
        <button type="button" className="btn" onClick={completeVortex}>
          Complete Vortex auth
        </button>
      </div>

      {msg && <p className={msg.startsWith('{') ? 'muted' : 'err'} style={{ marginTop: 16 }}>{msg}</p>}
    </section>
  );
}
