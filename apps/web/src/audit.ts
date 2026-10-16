import type { Tone } from './types';

export type AuditFilters = {
  user: string;
  server: string;
  outcome: string;
  from: string;
  to: string;
};
export const EMPTY_FILTERS: AuditFilters = { user: '', server: '', outcome: '', from: '', to: '' };
export const OUTCOMES = [
  'ok',
  'tool_error',
  'denied',
  'timeout',
  'unreachable',
  'disabled',
  'rate_limited',
  'bad_request',
  'upstream_error',
] as const;

// datetime-local values carry no zone: the browser's zone applies, and the API gets UTC.
export function auditQuery(f: AuditFilters, cursor?: string): string {
  const q = new URLSearchParams();
  if (f.user) q.set('user', f.user);
  if (f.server) q.set('server', f.server);
  if (f.outcome) q.set('outcome', f.outcome);
  if (f.from) q.set('from', new Date(f.from).toISOString());
  if (f.to) q.set('to', new Date(f.to).toISOString());
  if (cursor) q.set('cursor', cursor);
  return q.toString();
}

export function outcomeTone(outcome: string): Tone {
  if (outcome === 'ok') return 'ok';
  if (outcome === 'denied' || outcome === 'rate_limited' || outcome === 'disabled') return 'warn';
  return 'bad';
}

const GRANT_REVOKED = 'oauth_grant_revoked';

// The gateway writes tool calls to audit_events, and the control-plane reuses the table for a
// revoked OAuth grant. That row has no server slug and its message is a note, not an error.
export function auditEvent(r: {
  toolName: string;
  via: string;
  serverSlug: string;
  errorMessage: string | null;
}): { isEvent: boolean; server: string; detail: string | null } {
  if (r.toolName !== GRANT_REVOKED || r.via !== 'oauth' || r.serverSlug !== '')
    return { isEvent: false, server: r.serverSlug, detail: null };
  const m = r.errorMessage ?? '';
  return {
    isEvent: true,
    server: 'OAuth',
    detail: m ? m.charAt(0).toUpperCase() + m.slice(1) : null,
  };
}
