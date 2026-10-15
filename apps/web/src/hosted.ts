import { ApiError } from './api';
import { errorText } from './errors';
import type { HostedLimits, HostedStatus, Tone } from './types';

export type EnvRow = { name: string; value: string };
export type HostedForm = {
  slug: string;
  image: string;
  port: string;
  path: string;
  env: EnvRow[];
  secretEnv: EnvRow[];
  cpu: string;
  memory: string;
};

export const HOSTED_DEFAULTS = { port: '8080', path: '/mcp', cpu: '200m', memory: '128Mi' };

// A row with no name is an unused line in the form, not an entry. The API checks everything else.
const rows = (list: EnvRow[]): EnvRow[] =>
  list.filter((r) => r.name.trim() !== '').map((r) => ({ name: r.name.trim(), value: r.value }));

export function toHostedBody(f: HostedForm) {
  const port = Number.parseInt(f.port, 10);
  return {
    slug: f.slug.trim(),
    image: f.image.trim(),
    // The API refuses anything under 1024, which also covers a field that is not a number.
    port: Number.isFinite(port) ? port : 0,
    path: f.path.trim(),
    env: rows(f.env),
    secretEnv: rows(f.secretEnv),
    cpu: f.cpu.trim(),
    memory: f.memory.trim(),
  };
}

const PILLS: Record<
  HostedStatus,
  { label: 'Pending' | 'Ready' | 'Failed' | 'Deleting'; tone: Tone }
> = {
  pending: { label: 'Pending', tone: 'warn' },
  ready: { label: 'Ready', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  deleting: { label: 'Deleting', tone: 'off' },
};

export function hostedPill(status: HostedStatus) {
  return PILLS[status];
}

export const HOSTED_POLL_MS = 3000;

// false stops react-query's interval, so an idle page makes no requests.
export function hostedPollMs(servers: Array<{ status: HostedStatus }> | undefined): number | false {
  return servers?.some((s) => s.status === 'pending' || s.status === 'deleting')
    ? HOSTED_POLL_MS
    : false;
}

export function hostedErrorText(err: unknown, limits: HostedLimits | undefined): string {
  if (err instanceof ApiError && err.code === 'image_not_allowed') {
    const prefixes = limits?.allowedImagePrefixes ?? [];
    return `${errorText(err)} ${prefixes.length ? `Allowed prefixes: ${prefixes.join(', ')}` : 'No prefix is allowed on this platform.'}`;
  }
  if (err instanceof ApiError && err.code === 'invalid_hosted' && err.issues.length > 0) {
    return err.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
  }
  return errorText(err);
}
