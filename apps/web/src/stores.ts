import type { Store, Tone } from './types';

export type StorePill = { label: 'Provisioning' | 'Ready' | 'Failed' | 'Deleting'; tone: Tone };

const PILLS: Record<Store['status'], StorePill> = {
  provisioning: { label: 'Provisioning', tone: 'warn' },
  ready: { label: 'Ready', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  deleting: { label: 'Deleting', tone: 'off' },
};

export function storePill(s: Pick<Store, 'status'>): StorePill {
  return PILLS[s.status];
}

export const BUSY_POLL_MS = 2000;
export const IDLE_POLL_MS = 15000;

// Fast polling only while the provisioner works, so an idle page costs one request per 15 s.
export function storesPollMs(stores: Array<Pick<Store, 'status'>> | undefined): number {
  return stores?.some((s) => s.status === 'provisioning' || s.status === 'deleting')
    ? BUSY_POLL_MS
    : IDLE_POLL_MS;
}

export function elapsed(fromIso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

// Store provisioner: at most 3 install attempts inside the 15 minute deadline, counted from creation.
export function storeProgress(
  s: Pick<Store, 'status' | 'lastStep' | 'attempt' | 'createdAt'>,
  now = Date.now(),
): string {
  if (s.status === 'provisioning') {
    const attempt = Math.min(s.attempt + 1, 3);
    return `Step ${s.lastStep ?? 'queued'}, attempt ${attempt} of 3, ${elapsed(s.createdAt, now)} so far`;
  }
  if (s.status === 'deleting') return `Deleting: step ${s.lastStep ?? 'queued'}`;
  return '';
}

// crypto.randomUUID exists only in secure contexts and the local dashboard is plain http
// (app.127.0.0.1.nip.io), so build a version 4 UUID from getRandomValues, which every context has.
export function newIdempotencyKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
