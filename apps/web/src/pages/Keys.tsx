import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { KeyReveal } from '../KeyReveal';
import { KeyTable } from '../KeyTable';
import type { ApiKey } from '../types';
import { Button, ErrorLine, Field, Input, PageHeader } from '../ui';

export function KeysPage() {
  const qc = useQueryClient();
  const keys = useQuery({
    queryKey: ['keys'],
    queryFn: () => api<{ keys: ApiKey[] }>('/api/keys').then((r) => r.keys),
  });
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api<{ key: ApiKey; secret: string }>('/api/keys', {
        method: 'POST',
        body: { name: name.trim() },
      }),
    onSuccess: () => {
      setName('');
      void qc.invalidateQueries({ queryKey: ['keys'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['keys'] }),
  });
  return (
    <>
      <PageHeader title="My keys" />
      <form
        className="mb-4 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <Field label="New key name">
          <Input
            value={name}
            maxLength={100}
            placeholder="laptop-claude-code"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Button tone="primary" type="submit" disabled={!name.trim() || create.isPending}>
          Create key
        </Button>
      </form>
      <ErrorLine error={create.error ?? revoke.error ?? keys.error} />
      <KeyTable
        keys={keys.data ?? []}
        onRevoke={(k) =>
          window.confirm(`Revoke "${k.name}"? Clients using it stop working within a second.`) &&
          revoke.mutate(k.id)
        }
      />
      {create.data && (
        <KeyReveal
          secret={create.data.secret}
          title={`Key "${create.data.key.name}"`}
          onClose={() => create.reset()}
        />
      )}
    </>
  );
}
