import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useOutletContext } from 'react-router';
import { api } from '../api';
import { ago } from '../format';
import {
  HOSTED_DEFAULTS,
  hostedErrorText,
  hostedPill,
  hostedPollMs,
  toHostedBody,
  type EnvRow,
  type HostedForm,
} from '../hosted';
import type { HostedLimits, HostedResponse, HostedServer, Me } from '../types';
import { Button, Field, Input, Modal, PageHeader, Pill, td, th } from '../ui';

export function HostedPage() {
  const me = useOutletContext<Me>();
  if (me.role !== 'admin') return <p className="text-muted">Only admins manage hosted servers.</p>;
  return <Hosted />;
}

function Hosted() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['hosted'],
    queryFn: () => api<HostedResponse>('/api/hosted'),
    refetchInterval: (q) => hostedPollMs(q.state.data?.servers),
  });
  const [creating, setCreating] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['hosted'] });
  const remove = useMutation({
    mutationFn: (s: HostedServer) =>
      api<{ server: HostedServer }>(`/api/hosted/${s.id}`, { method: 'DELETE' }),
    onSuccess: ({ server }) => {
      // The row turns to Deleting at once and the 3 s refetch follows it until it is gone.
      qc.setQueryData<HostedResponse>(
        ['hosted'],
        (cur) =>
          cur && {
            ...cur,
            servers: cur.servers.map((s) => (s.id === server.id ? server : s)),
          },
      );
      refresh();
    },
  });
  const limits = list.data?.limits;
  const error = list.error ?? remove.error;
  return (
    <>
      <PageHeader title="Hosted servers">
        <Button tone="primary" onClick={() => setCreating(true)}>
          Create hosted server
        </Button>
      </PageHeader>
      {error && (
        <p className="my-2 text-bad" role="alert">
          {hostedErrorText(error, limits)}
        </p>
      )}
      <table className="w-full border-collapse rounded border border-line bg-panel">
        <thead>
          <tr>
            {['Slug', 'Image', 'Status', 'CPU', 'Memory', 'Created', ''].map((h) => (
              <th key={h} className={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.data?.servers.map((s) => {
            const pill = hostedPill(s.status);
            return (
              <tr key={s.id}>
                <td className={`${td} font-mono`}>{s.slug}</td>
                <td className={`${td} font-mono`}>{s.image}</td>
                <td className={`${td} max-w-sm`}>
                  <Pill tone={pill.tone}>{pill.label}</Pill>
                  {s.reason && <div className="mt-1 text-xs text-muted">{s.reason}</div>}
                </td>
                <td className={`${td} font-mono`}>{s.cpu}</td>
                <td className={`${td} font-mono`}>{s.memory}</td>
                <td className={td}>{ago(s.createdAt)}</td>
                <td className={`${td} whitespace-nowrap text-right`}>
                  {s.status !== 'deleting' && (
                    <Button
                      tone="danger"
                      disabled={remove.isPending}
                      onClick={() =>
                        window.confirm(
                          `Delete ${s.slug}? Its pod, Secret and network rules are removed and its tools disappear from every client. Audit rows stay. This cannot be undone.`,
                        ) && remove.mutate(s)
                      }
                    >
                      Delete
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {list.data?.servers.length === 0 && <p className="mt-3 text-muted">No hosted servers yet.</p>}
      {creating && limits && (
        <CreateHosted
          limits={limits}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}
    </>
  );
}

const EMPTY: HostedForm = {
  slug: '',
  image: '',
  env: [],
  secretEnv: [],
  ...HOSTED_DEFAULTS,
};

function CreateHosted({
  limits,
  onClose,
  onCreated,
}: {
  limits: HostedLimits;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState<HostedForm>(EMPTY);
  const set = <K extends keyof HostedForm>(k: K, v: HostedForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const create = useMutation({
    mutationFn: (f: HostedForm) => api('/api/hosted', { method: 'POST', body: toHostedBody(f) }),
    onSuccess: onCreated,
  });
  return (
    <Modal title="Create hosted server" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(form);
          // A secret does not stay in the page once it is sent. After an error the admin types it again.
          setForm((f) => ({ ...f, secretEnv: f.secretEnv.map((r) => ({ ...r, value: '' })) }));
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Slug">
            <Input
              value={form.slug}
              onChange={(e) => set('slug', e.target.value)}
              maxLength={24}
              required
              autoFocus
            />
          </Field>
          <Field label="Port">
            <Input
              value={form.port}
              onChange={(e) => set('port', e.target.value)}
              inputMode="numeric"
              required
            />
          </Field>
        </div>
        <Field label="Image">
          <Input
            value={form.image}
            onChange={(e) => set('image', e.target.value)}
            placeholder="name:tag"
            required
          />
        </Field>
        <p className="-mt-2 text-xs text-muted">
          {limits.allowedImagePrefixes.length > 0
            ? `Allowed image prefixes: ${limits.allowedImagePrefixes.join(', ')}. A tag or digest is required and latest is refused.`
            : 'No image prefix is allowed on this platform, so every create is refused.'}
        </p>
        <Field label="MCP path">
          <Input value={form.path} onChange={(e) => set('path', e.target.value)} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="CPU limit">
            <Input value={form.cpu} onChange={(e) => set('cpu', e.target.value)} required />
          </Field>
          <Field label="Memory limit">
            <Input value={form.memory} onChange={(e) => set('memory', e.target.value)} required />
          </Field>
        </div>
        <p className="-mt-2 text-xs text-muted">
          At most {limits.maxCpu} CPU and {limits.maxMemory} memory.
        </p>
        <EnvRows
          title="Environment variables"
          addLabel="Add variable"
          nameLabel="Variable name"
          valueLabel="Variable value"
          rows={form.env}
          onChange={(rows) => set('env', rows)}
        />
        <EnvRows
          title="Secret variables"
          addLabel="Add secret"
          nameLabel="Secret name"
          valueLabel="Secret value"
          secret
          rows={form.secretEnv}
          onChange={(rows) => set('secretEnv', rows)}
        />
        <p className="text-xs text-muted">
          The platform sets MCP_SHARED_TOKEN itself and sends the same token from the gateway.
          Secret values are encrypted, stored in a Kubernetes Secret and never shown again.
        </p>
        {create.error && (
          <p className="my-1 text-bad" role="alert">
            {hostedErrorText(create.error, limits)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" type="submit" disabled={create.isPending}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EnvRows({
  title,
  addLabel,
  nameLabel,
  valueLabel,
  secret = false,
  rows,
  onChange,
}: {
  title: string;
  addLabel: string;
  nameLabel: string;
  valueLabel: string;
  secret?: boolean;
  rows: EnvRow[];
  onChange: (rows: EnvRow[]) => void;
}) {
  const edit = (i: number, patch: Partial<EnvRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs text-muted">{title}</legend>
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <Input
            aria-label={`${nameLabel} ${i + 1}`}
            value={r.name}
            onChange={(e) => edit(i, { name: e.target.value })}
            className="font-mono"
          />
          <Input
            aria-label={`${valueLabel} ${i + 1}`}
            value={r.value}
            onChange={(e) => edit(i, { value: e.target.value })}
            type={secret ? 'password' : 'text'}
            autoComplete={secret ? 'off' : undefined}
            className="font-mono"
          />
          <Button onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</Button>
        </div>
      ))}
      <div>
        <Button onClick={() => onChange([...rows, { name: '', value: '' }])}>{addLabel}</Button>
      </div>
    </fieldset>
  );
}
