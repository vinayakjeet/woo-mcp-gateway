import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { definitionText, diffLines, showHidden, type DiffLine } from '../approvals';
import type { ApprovalServer, ApprovalTool, ApproveResult } from '../types';
import { Button, ErrorLine, PageHeader, Pill } from '../ui';

const LINE_STYLE: Record<DiffLine['kind'], string> = {
  same: '',
  add: 'bg-ok-bg text-ok',
  del: 'bg-bad-bg text-bad',
};

function Side({ testId, lines }: { testId: string; lines: DiffLine[] }) {
  return (
    <pre
      data-testid={testId}
      className="min-w-0 flex-1 overflow-x-auto rounded border border-line bg-canvas p-2 font-mono text-xs"
    >
      {lines.map((l, i) => (
        <div
          key={i}
          data-diff={l.kind}
          className={`whitespace-pre-wrap break-words ${LINE_STYLE[l.kind]}`}
        >
          {l.text || ' '}
        </div>
      ))}
    </pre>
  );
}

function ToolCard({ t }: { t: ApprovalTool }) {
  const next = showHidden(definitionText(t.current));
  const prev = t.approved ? showHidden(definitionText(t.approved)) : null;
  const diff = prev === null ? null : diffLines(prev, next);
  return (
    <li className="border-b border-line p-3 last:border-b-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono font-medium">{t.exposedName}</span>
        {t.flags.map((f) => (
          <Pill key={`${f.kind}-${f.detail}`} tone="warn">
            {`${f.kind}: ${f.detail}`}
          </Pill>
        ))}
      </div>
      {diff === null ? (
        <>
          <p className="mb-1 text-xs text-muted">New tool, nothing approved before.</p>
          <Side
            testId={`new-${t.exposedName}`}
            lines={next.split('\n').map((text) => ({ kind: 'same', text }))}
          />
        </>
      ) : (
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-xs text-muted">Approved</p>
            <Side testId={`old-${t.exposedName}`} lines={diff.filter((l) => l.kind !== 'add')} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-xs text-muted">Now</p>
            <Side testId={`new-${t.exposedName}`} lines={diff.filter((l) => l.kind !== 'del')} />
          </div>
        </div>
      )}
    </li>
  );
}

export function ToolApprovalsPage() {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['approvals'],
    queryFn: () => api<{ servers: ApprovalServer[] }>('/api/approvals').then((r) => r.servers),
    refetchInterval: 5000,
  });
  const approve = useMutation({
    // The hashes sent are the ones on screen, so a tool that changed in between stays hidden.
    mutationFn: (s: ApprovalServer) =>
      api<ApproveResult>(`/api/servers/${s.id}/approve`, {
        method: 'POST',
        body: { tools: Object.fromEntries(s.tools.map((t) => [t.name, t.definitionHash])) },
      }),
    onSuccess: (r) => {
      setNotice(
        r.stale.length > 0
          ? `${r.stale.join(', ')} changed again before the approval went through. Review ${r.stale.length === 1 ? 'it' : 'them'} again.`
          : null,
      );
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: ['servers'] });
    },
  });
  return (
    <>
      <PageHeader title="Tool approvals" />
      <p className="mb-3 text-muted">
        A new server and every tool an upstream adds or edits stay hidden from clients until you
        approve them here. Flags are hints from a text screen. They never block an approval.
      </p>
      <ErrorLine error={list.error ?? approve.error} />
      {notice && (
        <p className="mb-3 rounded bg-warn-bg px-3 py-2 text-warn" role="status">
          {notice}
        </p>
      )}
      {list.data?.length === 0 && <p className="text-muted">Nothing waits for approval.</p>}
      {list.data?.map((s) => (
        <section
          key={s.id}
          data-testid={`approval-${s.slug}`}
          className="mb-4 rounded border border-line bg-panel"
        >
          <div className="flex items-center gap-3 border-b border-line px-3 py-2">
            <h2 className="font-semibold">{s.name}</h2>
            <span className="font-mono text-xs text-muted">{s.slug}</span>
            <span className="truncate text-xs text-muted">{s.url}</span>
            {s.approval === 'pending' ? (
              <Pill tone="warn">Pending approval</Pill>
            ) : (
              <Pill tone="warn">Tools changed</Pill>
            )}
            <span className="ml-auto">
              <Button tone="primary" disabled={approve.isPending} onClick={() => approve.mutate(s)}>
                Approve
              </Button>
            </span>
          </div>
          <ul>
            {s.tools.map((t) => (
              <ToolCard key={t.name} t={t} />
            ))}
          </ul>
          {s.tools.length === 0 && (
            <p className="px-3 py-2 text-muted">
              No tools yet. Approving makes the server visible and its tools wait for approval.
            </p>
          )}
        </section>
      ))}
    </>
  );
}
