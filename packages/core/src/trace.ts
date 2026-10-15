import { randomBytes } from 'node:crypto';

export type TraceParent = { traceId: string; parentId: string; flags: string };

// W3C trace context, version 00 only. Anything else is treated as absent: a trace id comes from the
// client, so it is checked strictly before it reaches a log line or an upstream.
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(raw: unknown): TraceParent | null {
  if (typeof raw !== 'string') return null;
  const m = TRACEPARENT.exec(raw);
  if (!m) return null;
  const [, traceId = '', parentId = '', flags = ''] = m;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return { traceId, parentId, flags };
}

export const traceIdOf = (raw: unknown): string | null => parseTraceparent(raw)?.traceId ?? null;

const hex = (bytes: number): string => {
  // An all-zero id is invalid, and 8 random bytes can in theory be all zero.
  for (;;) {
    const s = randomBytes(bytes).toString('hex');
    if (!/^0+$/.test(s)) return s;
  }
};

const format = (t: TraceParent): string => `00-${t.traceId}-${t.parentId}-${t.flags}`;

export const newTraceparent = (): string =>
  format({ traceId: hex(16), parentId: hex(8), flags: '01' });

// Same trace and flags, a fresh parent id: one per outgoing call, so each hop has its own span.
export const childTraceparent = (parent: TraceParent): string =>
  format({ ...parent, parentId: hex(8) });
