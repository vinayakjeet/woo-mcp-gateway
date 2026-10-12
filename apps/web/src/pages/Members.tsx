import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { useOutletContext } from 'react-router';
import { api } from '../api';
import { formatTs } from '../format';
import { KeyReveal } from '../KeyReveal';
import { KeyTable } from '../KeyTable';
import { MEMBER_TONE, memberActions } from '../members';
import type { ApiKey, Me, Member, Role } from '../types';
import {
  Button,
  CopyButton,
  ErrorLine,
  Field,
  Input,
  PageHeader,
  Pill,
  Select,
  td,
  th,
} from '../ui';

export function MembersPage() {
  const me = useOutletContext<Me>();
  if (me.role !== 'admin') return <p className="text-muted">Only admins manage members.</p>;
  return <Members meId={me.id} />;
}

function Members({ meId }: { meId: string }) {
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ users: Member[] }>('/api/users').then((r) => r.users),
  });
  const patch = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: { role?: Role; status?: 'active' | 'disabled' };
    }) => api(`/api/users/${id}`, { method: 'PATCH', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Members" />
      <InviteForm />
      <ErrorLine error={users.error ?? patch.error} />
      <table className="w-full border-collapse rounded border border-line bg-panel">
        <thead>
          <tr>
            {['Email', 'Name', 'Role', 'Status', 'Active keys', 'Created', ''].map((h) => (
              <th key={h} className={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.data?.map((u) => {
            const a = memberActions(u, meId);
            return (
              <Fragment key={u.id}>
                <tr>
                  <td className={td}>{u.email}</td>
                  <td className={td}>{u.name ?? ''}</td>
                  <td className={td}>
                    <Select
                      value={u.role}
                      disabled={!a.canChangeRole}
                      aria-label={`Role of ${u.email}`}
                      onChange={(e) =>
                        patch.mutate({ id: u.id, body: { role: e.target.value as Role } })
                      }
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </Select>
                  </td>
                  <td className={td}>
                    <Pill tone={MEMBER_TONE[u.status]}>{u.status}</Pill>
                  </td>
                  <td className={td}>{u.activeKeys}</td>
                  <td className={td}>{formatTs(u.createdAt)}</td>
                  <td className={`${td} whitespace-nowrap text-right`}>
                    {a.canDisable && (
                      <Button
                        tone="danger"
                        onClick={() =>
                          window.confirm(
                            `Disable ${u.email}? Their sessions end and their keys stop working.`,
                          ) && patch.mutate({ id: u.id, body: { status: 'disabled' } })
                        }
                      >
                        Disable
                      </Button>
                    )}
                    {a.canEnable && (
                      <Button
                        onClick={() => patch.mutate({ id: u.id, body: { status: 'active' } })}
                      >
                        Enable
                      </Button>
                    )}{' '}
                    <Button onClick={() => setOpen(open === u.id ? null : u.id)}>
                      {open === u.id ? 'Hide keys' : 'Keys'}
                    </Button>
                  </td>
                </tr>
                {open === u.id && (
                  <tr>
                    <td colSpan={7} className="border-b border-line bg-canvas p-3">
                      <MemberKeys user={u} canIssue={a.canIssueKey} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function InviteForm() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const invite = useMutation({
    mutationFn: () =>
      api<{ url: string; expiresAt: string }>('/api/invites', {
        method: 'POST',
        body: { email: email.trim(), role },
      }),
    onSuccess: () => {
      setEmail('');
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
  return (
    <div className="mb-4 rounded border border-line bg-panel p-3">
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          invite.mutate();
        }}
      >
        <Field label="Invite by email">
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </Select>
        </Field>
        <Button tone="primary" type="submit" disabled={invite.isPending}>
          Create invite link
        </Button>
      </form>
      <ErrorLine error={invite.error} />
      {invite.data && (
        <div className="mt-3">
          <p className="mb-1 text-xs text-muted">
            One-time link, valid until {formatTs(invite.data.expiresAt)}. No email is sent: give it
            to the person yourself.
          </p>
          <div className="flex gap-2">
            <Input
              readOnly
              value={invite.data.url}
              aria-label="Invite link"
              className="flex-1 font-mono"
              onFocus={(e) => e.currentTarget.select()}
            />
            <CopyButton text={invite.data.url} />
          </div>
        </div>
      )}
    </div>
  );
}

function MemberKeys({ user, canIssue }: { user: Member; canIssue: boolean }) {
  const qc = useQueryClient();
  const path = `/api/users/${user.id}/keys`;
  const keys = useQuery({
    queryKey: ['user-keys', user.id],
    queryFn: () => api<{ keys: ApiKey[] }>(path).then((r) => r.keys),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['user-keys', user.id] });
    void qc.invalidateQueries({ queryKey: ['users'] });
  };
  const [name, setName] = useState('');
  const issue = useMutation({
    mutationFn: () =>
      api<{ key: ApiKey; secret: string }>(path, { method: 'POST', body: { name: name.trim() } }),
    onSuccess: () => {
      setName('');
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  return (
    <>
      {canIssue && (
        <form
          className="mb-3 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) issue.mutate();
          }}
        >
          <Field label={`Issue a key for ${user.email}`}>
            <Input
              value={name}
              maxLength={100}
              placeholder="key name"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={!name.trim() || issue.isPending}>
            Issue key
          </Button>
        </form>
      )}
      <ErrorLine error={keys.error ?? issue.error ?? revoke.error} />
      <KeyTable
        keys={keys.data ?? []}
        onRevoke={(k) =>
          window.confirm(`Revoke "${k.name}" of ${user.email}?`) && revoke.mutate(k.id)
        }
      />
      {issue.data && (
        <KeyReveal
          secret={issue.data.secret}
          title={`Key "${issue.data.key.name}" for ${user.email}`}
          onClose={() => issue.reset()}
        />
      )}
    </>
  );
}
