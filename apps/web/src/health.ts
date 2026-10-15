import { serverPill, type Pill } from './servers';
import type { ServerHealth } from './types';

export const HEALTH_WINDOW = '60m';
export const HEALTH_REFRESH_MS = 10_000;

export const formatRate = (v: number | null): string =>
  v === null ? '-' : `${(v * 100).toFixed(1)}%`;

export const formatMs = (v: number | null): string => (v === null ? '-' : `${Math.round(v)} ms`);

// Calls per minute are small numbers on a quiet system, so they keep two decimals until 10.
export const formatPerMinute = (v: number): string =>
  v < 10 ? v.toFixed(2) : String(Math.round(v));

export function healthPill(s: Pick<ServerHealth, 'enabled' | 'approval' | 'state'>): Pill {
  return serverPill({
    enabled: s.enabled,
    approval: s.approval,
    status: s.state ? { state: s.state } : null,
  });
}
