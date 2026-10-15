import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useOutletContext } from 'react-router';
import { api } from '../api';
import { previewTools } from '../policies';
import type { Me, Policy, Role, Server } from '../types';
import { Button, ErrorLine, Field, Input, Modal, PageHeader, Pill, Select, td, th } from '../ui';

export function PoliciesPage() {
  const me = useOutletContext<Me>();
  const admin = me.role === 'admin';
  const qc = useQueryClient();
  const policies = useQuery({
    queryKey: ['policies'],
    queryFn: () => api<{ policies: Policy[] }>('/api/policies').then((r) => r.policies),
  });
  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: () => api<{ servers: Server[] }>('/api/servers').then((r) => r.servers),
    refetchInterval: 5000,
  });
  const [adding, setAdding] = useState(false);
  const [previewRole, setPreviewRole] = useState<Role>('member');
  // A rule changes the roles column of every tool, so both lists are fetched again.
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['policies'] });
    void qc.invalidateQueries({ queryKey: ['servers'] });
  };
  const remove = useMutation({
    mutationFn: (p: Policy) => api(`/api/policies/${p.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const preview = previewTools(servers.data ?? [], previewRole);
  return (
    <>
      <PageHeader title="Policies">
        {admin && (
          <Button tone="primary" onClick={() => setAdding(true)}>
            Add rule
          </Button>
        )}
      </PageHeader>
      <p className="mb-3 text-muted">
        Rules run from the highest priority down and the first match decides. At equal priority a
        deny wins. With no match an admin is allowed and a member is denied. A hidden tool is
        missing from the tool list and answers like an unknown tool.
      </p>
      <ErrorLine error={policies.error ?? servers.error ?? remove.error} />
      <table className="w-full border-collapse rounded border border-line bg-panel">
        <thead>
          <tr>
            {['Priority', 'Role', 'Server', 'Tool', 'Effect', ''].map((h) => (
              <th key={h} className={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {policies.data?.map((p) => (
            <tr key={p.id} data-testid="policy-row">
              <td className={td}>{p.priority}</td>
              <td className={td}>{p.role}</td>
              <td className={`${td} font-mono`}>{p.serverPattern}</td>
              <td className={`${td} font-mono`}>{p.toolPattern}</td>
              <td className={td}>
                <Pill tone={p.effect === 'allow' ? 'ok' : 'bad'}>{p.effect}</Pill>
              </td>
              <td className={`${td} text-right`}>
                {admin && (
                  <Button
                    tone="danger"
                    disabled={remove.isPending}
                    onClick={() =>
                      window.confirm(
                        `Delete the rule ${p.effect} ${p.role} ${p.serverPattern} / ${p.toolPattern}? Tools it allowed or hid change for every client.`,
                      ) && remove.mutate(p)
                    }
                  >
                    Delete
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {policies.data?.length === 0 && <p className="mt-3 text-muted">No rules.</p>}

      <section className="mt-6" data-testid="preview">
        <div className="mb-2 flex items-center gap-3">
          <h2 className="font-semibold">Tool list preview</h2>
          <Field label="Preview as" className="flex-row items-center gap-2">
            <Select value={previewRole} onChange={(e) => setPreviewRole(e.target.value as Role)}>
              <option value="member">member</option>
              <option value="admin">admin</option>
            </Select>
          </Field>
          <span className="text-xs text-muted">{preview.length} tools</span>
        </div>
        <ul className="rounded border border-line bg-panel">
          {preview.map((t) => (
            <li
              key={t.exposedName}
              className="flex gap-3 border-b border-line px-2 py-1 last:border-b-0"
            >
              <span className="font-mono">{t.exposedName}</span>
              <span className="truncate text-muted">{t.description ?? ''}</span>
            </li>
          ))}
          {preview.length === 0 && <li className="px-2 py-1 text-muted">No tools.</li>}
        </ul>
      </section>

      {adding && (
        <AddRule
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
    </>
  );
}

function AddRule({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [f, setF] = useState({
    role: 'member' as Role,
    serverPattern: '',
    toolPattern: '',
    effect: 'deny' as 'allow' | 'deny',
    priority: '10',
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const add = useMutation({
    mutationFn: () =>
      api('/api/policies', { method: 'POST', body: { ...f, priority: Number(f.priority) } }),
    onSuccess: onAdded,
  });
  return (
    <Modal title="Add rule" onClose={onClose}>
      <form
        className="grid grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="Role">
          <Select value={f.role} onChange={(e) => set('role', e.target.value as Role)}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </Select>
        </Field>
        <Field label="Effect">
          <Select
            value={f.effect}
            onChange={(e) => set('effect', e.target.value as 'allow' | 'deny')}
          >
            <option value="deny">deny</option>
            <option value="allow">allow</option>
          </Select>
        </Field>
        <Field label="Server pattern">
          <Input
            required
            maxLength={24}
            placeholder="main or *"
            className="font-mono"
            value={f.serverPattern}
            onChange={(e) => set('serverPattern', e.target.value)}
          />
        </Field>
        <Field label="Tool pattern">
          <Input
            required
            maxLength={128}
            placeholder="list_* or *"
            className="font-mono"
            value={f.toolPattern}
            onChange={(e) => set('toolPattern', e.target.value)}
          />
        </Field>
        <Field label="Priority">
          <Input
            required
            type="number"
            min={-1000}
            max={1000}
            step={1}
            value={f.priority}
            onChange={(e) => set('priority', e.target.value)}
          />
        </Field>
        <p className="col-span-2 text-xs text-muted">
          * matches any run of characters. Every other character is literal and the match is
          case-sensitive.
        </p>
        <div className="col-span-2">
          <ErrorLine error={add.error} />
        </div>
        <div className="col-span-2 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" tone="primary" disabled={add.isPending}>
            Add rule
          </Button>
        </div>
      </form>
    </Modal>
  );
}
