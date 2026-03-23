import { NavLink, Outlet } from 'react-router-dom';
import { getAdminToken } from '../lib/api-client';
import { useAuthAlert } from '../hooks/useAuthAlert';

const links = [
  { to: '/', label: 'Overview' },
  { to: '/keys', label: 'API keys' },
  { to: '/provider', label: 'Provider & stream' },
  { to: '/ws', label: 'WebSocket admin' },
  { to: '/abuse', label: 'Abuse' },
  { to: '/audit', label: 'Audit & debug' },
  { to: '/auth', label: 'Auth' },
  { to: '/console', label: 'API console' },
  { to: '/settings', label: 'Settings' },
];

export function Layout() {
  const hasToken = !!getAdminToken();
  const { unauthorized, setUnauthorized } = useAuthAlert();

  return (
    <div className="layout">
      {unauthorized && (
        <div
          className="card"
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
      <header className="top">
        <h1>Trading data admin</h1>
        <nav className="nav">
          {links.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              {label}
            </NavLink>
          ))}
          <a href={`${import.meta.env.BASE_URL}legacy-dashboard.html`}>Legacy UI</a>
        </nav>
      </header>
      {!hasToken && (
        <p className="err" style={{ marginTop: 12 }}>
          Set your admin token under <NavLink to="/settings">Settings</NavLink> to enable protected actions and live
          admin panels.
        </p>
      )}
      <Outlet />
    </div>
  );
}
