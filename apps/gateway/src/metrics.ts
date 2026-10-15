import { MetricsRegistry } from '@woo/core';
import type { AuditRow, Outcome } from './types.js';

export type ServerStat = { slug: string; up: boolean; toolsExposed: number };
export type MetricsView = { serverStats(): ServerStat[] };

// 15 s is the default upstream timeout, so the top finite bucket holds a normal timeout.
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30];
// Outcomes where the call reached the upstream or tried to. The rest never waited on one.
const ATTEMPTED: ReadonlySet<Outcome> = new Set([
  'ok',
  'tool_error',
  'timeout',
  'unreachable',
  'upstream_error',
]);

// A label value comes from the registry or is a fixed word. Text the client sent never becomes a
// label, so no client can create series by inventing tool names.
export const serverLabel = (row: AuditRow): string =>
  row.serverId ? row.serverSlug : row.metaTool === 'search_tools' ? '_search' : '_unknown';

export function createGatewayMetrics(view: MetricsView) {
  const reg = new MetricsRegistry();
  const calls = reg.counter('gateway_tool_calls_total', 'Tool calls by server and audit outcome.', [
    'server',
    'outcome',
  ]);
  const duration = reg.histogram(
    'gateway_tool_call_duration_seconds',
    'Time from the call to the upstream answer, for calls that reached or tried the upstream.',
    ['server'],
    DURATION_BUCKETS,
  );
  reg.gauge(
    'gateway_upstream_up',
    'Whether this replica sees the server connected (1) or not (0).',
    ['server'],
    () => view.serverStats().map((s) => ({ labels: { server: s.slug }, value: s.up ? 1 : 0 })),
  );
  reg.gauge(
    'gateway_tools_exposed',
    'Active tools of an enabled, connected and approved server, before policy.',
    ['server'],
    () => view.serverStats().map((s) => ({ labels: { server: s.slug }, value: s.toolsExposed })),
  );
  return {
    // Fed from the finished audit row, so the counters and the audit log cannot disagree.
    observe(row: AuditRow): void {
      const server = serverLabel(row);
      calls.inc({ server, outcome: row.outcome });
      if (ATTEMPTED.has(row.outcome)) duration.observe({ server }, row.durationMs / 1000);
    },
    render: () => reg.render(),
  };
}

export type GatewayMetrics = ReturnType<typeof createGatewayMetrics>;
