import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useOutletContext } from 'react-router';
import { api } from '../api';
import { ago } from '../format';
import { newIdempotencyKey, storePill, storeProgress, storesPollMs } from '../stores';
import type { Me, Store } from '../types';
import { Button, ErrorLine, Field, Input, Modal, PageHeader, Pill, td, th } from '../ui';

export function StoresPage() {
  const me = useOutletContext<Me>();
  const admin = me.role === 'admin';
  const qc = useQueryClient();
  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ stores: Store[] }>('/api/stores').then((r) => r.stores),
    refetchInterval: (q) => storesPollMs(q.state.data),
  });
  const [creating, setCreating] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['stores'] });
  const remove = useMutation({
    mutationFn: (s: Store) => api(`/api/stores/${s.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const headers = [
    'Status',
    'Name',
    'Address',
    'Progress',
    'Storefront',
    ...(admin ? ['Owner'] : []),
    'Created',
    '',
  ];
  return (
    <>
      <PageHeader title="Stores">
        <Button tone="primary" onClick={() => setCreating(true)}>
          Create store
        </Button>
      </PageHeader>
      <ErrorLine error={stores.error ?? remove.error} />
      <table className="w-full border-collapse rounded border border-line bg-panel">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} className={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stores.data?.map((s) => {
            const pill = storePill(s);
            return (
              <tr key={s.id}>
                <td className={td}>
                  <Pill tone={pill.tone}>{pill.label}</Pill>
                </td>
                <td className={td}>{s.name}</td>
                <td className={`${td} font-mono`}>{s.slug}</td>
                <td className={`${td} max-w-sm`}>
                  <div>{storeProgress(s)}</div>
                  {s.statusReason && <div className="text-xs text-muted">{s.statusReason}</div>}
                </td>
                <td className={td}>
                  {s.url && (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline"
                    >
                      {s.url.replace(/^https?:\/\//, '')}
                    </a>
                  )}
                </td>
                {admin && <td className={td}>{s.owner.email}</td>}
                <td className={td}>{ago(s.createdAt)}</td>
                <td className={`${td} whitespace-nowrap text-right`}>
                  {s.deletable && (
                    <Button
                      tone="danger"
                      disabled={remove.isPending}
                      onClick={() =>
                        window.confirm(
                          `Delete ${s.name}? Its database, files and namespace are removed and its tools disappear from every client. This cannot be undone.`,
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
      {stores.data?.length === 0 && <p className="mt-3 text-muted">No stores yet.</p>}
      {creating && (
        <CreateStore
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

function CreateStore({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  // One key per opened form: a double click or a retry after a network error gets the same store.
  const [key] = useState(newIdempotencyKey);
  const create = useMutation({
    mutationFn: () =>
      api('/api/stores', {
        method: 'POST',
        body: { name },
        headers: { 'idempotency-key': key },
      }),
    onSuccess: onCreated,
  });
  return (
    <Modal title="Create store" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            required
            autoFocus
          />
        </Field>
        <p className="text-xs text-muted">
          The address comes from the name. Setup takes a few minutes; this page follows it.
        </p>
        <ErrorLine error={create.error} />
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
