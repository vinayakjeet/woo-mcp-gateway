import { useQueryClient } from '@tanstack/react-query';
import { Navigate, NavLink, Outlet, useNavigate } from 'react-router';
import { api, ApiError } from './api';
import { useConfig, useMe } from './session';

export const NAV: Array<{ to: string; label: string; admin: boolean }> = [
  { to: '/servers', label: 'Servers', admin: false },
  { to: '/members', label: 'Members', admin: true },
  { to: '/keys', label: 'My keys', admin: false },
];

export function Shell() {
  const me = useMe();
  const config = useConfig();
  const qc = useQueryClient();
  const navigate = useNavigate();
  if (me.isPending) return <div className="p-6 text-muted">Loading</div>;
  if (me.error instanceof ApiError && me.error.status === 401)
    return <Navigate to="/login" replace />;
  if (me.isError) return <div className="p-6 text-bad">Could not reach the API.</div>;
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    qc.clear();
    navigate('/login', { replace: true });
  };
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-48 shrink-0 flex-col border-r border-line bg-panel px-3 py-4">
        <div className="mb-4 px-2 font-semibold">Urumi gateway</div>
        <nav className="flex flex-col gap-0.5">
          {NAV.filter((n) => !n.admin || me.data.role === 'admin').map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `rounded px-2 py-1 ${isActive ? 'bg-canvas font-medium text-ink' : 'text-muted hover:text-ink'}`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto border-t border-line px-2 pt-3 text-muted">
          <div className="truncate text-ink">{me.data.email}</div>
          <div className="text-xs">{me.data.role}</div>
          <button type="button" onClick={logout} className="mt-2 text-accent hover:underline">
            Log out
          </button>
          {config.data && <div className="mt-3 text-xs">v{config.data.version}</div>}
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-6 py-4">
        <Outlet context={me.data} />
      </main>
    </div>
  );
}
