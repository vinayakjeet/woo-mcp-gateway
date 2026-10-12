import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from './api';
import { formFromServer, serverCreate, serverPatch, type ServerFormState } from './servers';
import type { Server } from './types';
import { Button, ErrorLine, Field, Input, Modal, Select } from './ui';

export function ServerForm({
  server,
  onClose,
  onSaved,
}: {
  server: Server | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<ServerFormState>(() => formFromServer(server));
  const set = <K extends keyof ServerFormState>(k: K, v: ServerFormState[K]) =>
    setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: async () => {
      if (!server) return api('/api/servers', { method: 'POST', body: serverCreate(f) });
      const body = serverPatch(f, server);
      if (Object.keys(body).length > 0)
        await api(`/api/servers/${server.id}`, { method: 'PATCH', body });
    },
    onSuccess: onSaved,
  });
  const locked = server?.managed ?? false;
  return (
    <Modal title={server ? `Edit ${server.name}` : 'Add server'} onClose={onClose}>
      <form
        className="grid grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name">
          <Input
            required
            value={f.name}
            disabled={locked}
            maxLength={100}
            onChange={(e) => set('name', e.target.value)}
          />
        </Field>
        <Field label={server ? 'Slug (fixed)' : 'Slug (cannot change later)'}>
          <Input
            required
            value={f.slug}
            disabled={server !== null}
            className="font-mono"
            onChange={(e) => set('slug', e.target.value)}
          />
        </Field>
        <Field label="URL" className="col-span-2">
          <Input
            required
            type="url"
            value={f.url}
            disabled={locked}
            className="font-mono"
            onChange={(e) => set('url', e.target.value)}
          />
        </Field>
        <Field label="Auth">
          <Select
            value={f.authType}
            disabled={locked}
            onChange={(e) => set('authType', e.target.value as ServerFormState['authType'])}
          >
            <option value="none">none</option>
            <option value="bearer">bearer token</option>
            <option value="header">custom header</option>
          </Select>
        </Field>
        {f.authType === 'header' ? (
          <Field label="Header name">
            <Input
              required
              value={f.headerName}
              disabled={locked}
              className="font-mono"
              onChange={(e) => set('headerName', e.target.value)}
            />
          </Field>
        ) : (
          <div />
        )}
        {f.authType !== 'none' && (
          <Field label="Secret (write-only)" className="col-span-2">
            <Input
              type="password"
              autoComplete="new-password"
              value={f.secret}
              disabled={locked}
              required={!server?.auth.hasSecret}
              placeholder={server?.auth.hasSecret ? 'set (type to replace)' : ''}
              onChange={(e) => set('secret', e.target.value)}
            />
          </Field>
        )}
        <Field label="Timeout (ms)">
          <Input
            type="number"
            min={1000}
            max={60000}
            step={500}
            value={f.timeoutMs}
            onChange={(e) => set('timeoutMs', Number(e.target.value))}
          />
        </Field>
        <Field label="Protocol">
          <Select
            value={f.protocolMode}
            disabled={locked}
            onChange={(e) => set('protocolMode', e.target.value as ServerFormState['protocolMode'])}
          >
            <option value="legacy">legacy</option>
            <option value="auto">auto</option>
          </Select>
        </Field>
        {locked && (
          <p className="col-span-2 text-xs text-muted">
            Managed server: the platform owns its name, URL, auth and protocol. Only the timeout
            changes here.
          </p>
        )}
        <div className="col-span-2">
          <ErrorLine error={save.error} />
        </div>
        <div className="col-span-2 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" type="submit" disabled={save.isPending}>
            {server ? 'Save' : 'Add server'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
