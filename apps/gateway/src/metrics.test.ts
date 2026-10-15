import { describe, expect, it } from 'vitest';
import { createGatewayMetrics, serverLabel } from './metrics.js';
import type { AuditRow, Outcome } from './types.js';

function row(over: Partial<AuditRow> = {}): AuditRow {
  return {
    requestId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    userEmail: 'dev@example.com',
    via: 'api_key',
    apiKeyId: null,
    serverId: 'id-main',
    serverSlug: 'main',
    toolName: 'get_info',
    exposedName: 'main__get_info',
    metaTool: null,
    outcome: 'ok',
    durationMs: 120,
    errorMessage: null,
    argsSha256: 'abc',
    replica: 'r1',
    protocolVersion: null,
    ...over,
  };
}

const view = (servers: Array<{ slug: string; up: boolean; toolsExposed: number }> = []) => ({
  serverStats: () => servers,
});

describe('gateway metrics', () => {
  it('names the four SPEC 20 metrics', () => {
    const out = createGatewayMetrics(view()).render();
    for (const n of [
      'gateway_tool_calls_total',
      'gateway_tool_call_duration_seconds',
      'gateway_upstream_up',
      'gateway_tools_exposed',
    ])
      expect(out).toContain(`# TYPE ${n} `);
  });

  it('adds 1 to gateway_tool_calls_total{server,outcome} for an ok call', () => {
    const m = createGatewayMetrics(view());
    m.observe(row());
    m.observe(row());
    expect(m.render()).toContain('gateway_tool_calls_total{server="main",outcome="ok"} 2\n');
  });

  it('counts search_tools under _search', () => {
    const m = createGatewayMetrics(view());
    m.observe(
      row({ serverId: null, serverSlug: '', metaTool: 'search_tools', toolName: 'search_tools' }),
    );
    expect(m.render()).toContain('gateway_tool_calls_total{server="_search",outcome="ok"} 1\n');
  });

  it('counts an unknown name under _unknown and adds no series per invented name', () => {
    const m = createGatewayMetrics(view());
    for (let i = 0; i < 50; i++)
      m.observe(
        row({
          serverId: null,
          serverSlug: `inv${i}`,
          toolName: `t${i}`,
          exposedName: `inv${i}__t${i}`,
          outcome: 'bad_request',
        }),
      );
    const out = m.render();
    expect(out).toContain('gateway_tool_calls_total{server="_unknown",outcome="bad_request"} 50\n');
    expect(out).not.toContain('inv1');
    expect(out.match(/^gateway_tool_calls_total\{/gm)).toHaveLength(1);
  });

  it('observes the duration of attempted calls only', () => {
    const m = createGatewayMetrics(view());
    const attempted: Outcome[] = ['ok', 'tool_error', 'timeout', 'unreachable', 'upstream_error'];
    const skipped: Outcome[] = ['denied', 'rate_limited', 'disabled', 'bad_request'];
    for (const outcome of [...attempted, ...skipped]) m.observe(row({ outcome, durationMs: 300 }));
    const out = m.render();
    expect(out).toContain('gateway_tool_call_duration_seconds_count{server="main"} 5\n');
    expect(out).toContain('gateway_tool_call_duration_seconds_bucket{server="main",le="0.5"} 5\n');
    expect(out).toContain('gateway_tool_call_duration_seconds_bucket{server="main",le="0.25"} 0\n');
    for (const o of [...attempted, ...skipped])
      expect(out).toContain(`gateway_tool_calls_total{server="main",outcome="${o}"} 1\n`);
  });

  it('reports upstream_up and tools_exposed from the registry view at scrape time', () => {
    const servers = [
      { slug: 'main', up: true, toolsExposed: 12 },
      { slug: 'fx', up: false, toolsExposed: 0 },
    ];
    const m = createGatewayMetrics(view(servers));
    let out = m.render();
    expect(out).toContain('gateway_upstream_up{server="main"} 1\n');
    expect(out).toContain('gateway_upstream_up{server="fx"} 0\n');
    expect(out).toContain('gateway_tools_exposed{server="main"} 12\n');
    expect(out).toContain('gateway_tools_exposed{server="fx"} 0\n');
    servers[1] = { slug: 'fx', up: true, toolsExposed: 3 };
    out = m.render();
    expect(out).toContain('gateway_upstream_up{server="fx"} 1\n');
  });

  it('never prints emails, ids, tokens, hashes or error text', () => {
    const m = createGatewayMetrics(view([{ slug: 'main', up: true, toolsExposed: 1 }]));
    m.observe(row({ errorMessage: 'boom secret-text', outcome: 'tool_error' }));
    const out = m.render();
    for (const s of ['dev@example.com', '00000000-0000', 'abc', 'secret-text', 'get_info'])
      expect(out).not.toContain(s);
  });
});

describe('serverLabel', () => {
  it('uses the slug only for a resolved route', () => {
    expect(serverLabel(row())).toBe('main');
    expect(serverLabel(row({ serverId: null, serverSlug: 'evil' }))).toBe('_unknown');
    expect(serverLabel(row({ serverId: null, metaTool: 'search_tools' }))).toBe('_search');
  });
});
