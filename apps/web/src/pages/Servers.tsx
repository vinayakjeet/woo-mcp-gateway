import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { useOutletContext } from 'react-router';
import { api } from '../api';
import { ago } from '../format';
import { ServerForm } from '../ServerForm';
import { serverPill } from '../servers';
import type { Me, Server } from '../types';
import { Button, ErrorLine, PageHeader, Pill, td, th } from '../ui';

export function ServersPage() {
  const me = useOutletContext<Me>();
  const admin = me.role === 'admin';
  const qc = useQueryClient();
  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: () => api<{ servers: Server[] }>('/api/servers').then((r) => r.servers),
    refetchInterval: 5000,
  });
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<Server | 'new' | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['servers'] });
  const toggle = useMutation({
    mutationFn: (s: Server) =>
      api(`/api/servers/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (s: Server) => api(`/api/servers/${s.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  return (
    <>
      <PageHeader title="Servers">
        {admin && (
          <Button tone="primary" onClick={() => setEditing('new')}>
            Add server
          </Button>
        )}
      </PageHeader>
      <ErrorLine error={servers.error ?? toggle.error ?? remove.error} />
      <table className="w-full border-collapse rounded border border-line bg-panel">
        <thead>
          <tr>
            {['Status', 'Name', 'Slug', 'Kind', 'Tools', 'Last error', 'Last checked', ''].map(
              (h) => (
                <th key={h} className={th}>
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {servers.data?.map((s) => {
            const pill = serverPill(s);
            return (
              <Fragment key={s.id}>
                <tr
                  className="cursor-pointer hover:bg-canvas"
                  onClick={() => setOpen(open === s.id ? null : s.id)}
                >
                  <td className={td}>
                    <Pill tone={pill.tone}>{pill.label}</Pill>
                  </td>
                  <td className={td}>{s.name}</td>
                  <td className={`${td} font-mono`}>{s.slug}</td>
                  <td className={td}>
                    {s.kind}
                    {s.managed ? ', managed' : ''}
                  </td>
                  <td className={td}>{s.status?.toolCount ?? 0}</td>
                  <td className={`${td} max-w-xs truncate`} title={s.status?.errorMessage ?? ''}>
                    {s.status?.errorKind
                      ? `${s.status.errorKind}: ${s.status.errorMessage ?? ''}`
                      : ''}
                  </td>
                  <td className={td}>{s.status?.checkedAt ? ago(s.status.checkedAt) : 'never'}</td>
                  <td
                    className={`${td} whitespace-nowrap text-right`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {admin && (
                      <>
                        <Button onClick={() => setEditing(s)}>Edit</Button>{' '}
                        <Button onClick={() => toggle.mutate(s)}>
                          {s.enabled ? 'Disable' : 'Enable'}
                        </Button>{' '}
                        {!s.managed && (
                          <Button
                            tone="danger"
                            onClick={() =>
                              window.confirm(
                                `Remove ${s.name} (${s.slug})? Its tools disappear from every client.`,
                              ) && remove.mutate(s)
                            }
                          >
                            Remove
                          </Button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
                {open === s.id && (
                  <tr>
                    <td colSpan={8} className="border-b border-line bg-canvas px-4 py-2">
                      <ToolTable server={s} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {editing && (
        <ServerForm
          server={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

function ToolTable({ server }: { server: Server }) {
  if (server.tools.length === 0) return <p className="text-muted">No tools listed yet.</p>;
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          {['Exposed name', 'Description', 'Read-only'].map((h) => (
            <th key={h} className={th}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {server.tools.map((t) => (
          <tr key={t.exposedName}>
            <td className={`${td} font-mono`}>{t.exposedName}</td>
            <td className={td}>{t.description ?? ''}</td>
            <td className={td}>{t.readOnly ? 'yes' : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
