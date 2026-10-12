import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useOutletContext } from 'react-router';
import { api } from '../api';
import { type AuditFilters, auditQuery, EMPTY_FILTERS, OUTCOMES, outcomeTone } from '../audit';
import { formatTs } from '../format';
import type { AuditResponse, Me, Member, Server } from '../types';
import { Button, ErrorLine, Field, Input, PageHeader, Pill, Select, td, th } from '../ui';

export function AuditPage() {
  const me = useOutletContext<Me>();
  const admin = me.role === 'admin';
  const [f, setF] = useState<AuditFilters>(EMPTY_FILTERS);
  const set = (k: keyof AuditFilters, v: string) => setF((x) => ({ ...x, [k]: v }));
  // On refetch TanStack Query refetches the loaded pages in order from the first, recomputing each
  // cursor, so rows that arrive while older pages are open are neither skipped nor repeated.
  const audit = useInfiniteQuery({
    queryKey: ['audit', f],
    queryFn: ({ pageParam }) => api<AuditResponse>(`/api/audit?${auditQuery(f, pageParam)}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 5000,
  });
  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: () => api<{ servers: Server[] }>('/api/servers').then((r) => r.servers),
  });
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ users: Member[] }>('/api/users').then((r) => r.users),
    enabled: admin,
  });
  const rows = audit.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader title="Audit log">
        <span className="text-xs text-muted">
          {audit.isFetching ? 'Refreshing' : 'Refreshes every 5 s'}
        </span>
      </PageHeader>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        {admin && (
          <Field label="User">
            <Select value={f.user} onChange={(e) => set('user', e.target.value)}>
              <option value="">all</option>
              {users.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Server">
          <Select value={f.server} onChange={(e) => set('server', e.target.value)}>
            <option value="">all</option>
            {servers.data?.map((s) => (
              <option key={s.id} value={s.slug}>
                {s.slug}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Outcome">
          <Select value={f.outcome} onChange={(e) => set('outcome', e.target.value)}>
            <option value="">all</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From">
          <Input
            type="datetime-local"
            value={f.from}
            onChange={(e) => set('from', e.target.value)}
          />
        </Field>
        <Field label="To">
          <Input type="datetime-local" value={f.to} onChange={(e) => set('to', e.target.value)} />
        </Field>
        <Button onClick={() => setF(EMPTY_FILTERS)}>Clear</Button>
      </div>
      <ErrorLine error={audit.error} />
      <table className="w-full border-collapse rounded border border-line bg-panel">
        <thead>
          <tr>
            {['Time', 'User', 'Via', 'Server', 'Tool', 'Outcome', 'Duration', 'Replica'].map(
              (h) => (
                <th key={h} className={th}>
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} title={r.errorMessage ?? ''}>
              <td className={`${td} whitespace-nowrap font-mono`}>{formatTs(r.ts)}</td>
              <td className={td}>{r.userEmail}</td>
              <td className={td}>{r.via}</td>
              <td className={`${td} font-mono`}>{r.serverSlug}</td>
              <td className={`${td} font-mono`}>{r.toolName}</td>
              <td className={td}>
                <Pill tone={outcomeTone(r.outcome)}>{r.outcome}</Pill>
              </td>
              <td className={`${td} text-right tabular-nums`}>{r.durationMs} ms</td>
              <td className={`${td} font-mono text-muted`}>{r.replica}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && !audit.isPending && (
        <p className="mt-2 text-muted">No rows for these filters.</p>
      )}
      {audit.hasNextPage && (
        <div className="mt-3">
          <Button onClick={() => void audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
            Load older
          </Button>
        </div>
      )}
    </>
  );
}
