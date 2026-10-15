import { Client, InMemoryTransport, type Tool } from '@modelcontextprotocol/client';
import { SEED_POLICIES, evaluatePolicy, type PolicyRule } from '@woo/core';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from './canonical.js';
import { createGatewayServer } from './mcp.js';
import { Registry } from './registry.js';
import { unlimited, quietLog } from './test-helpers.js';
import type {
  AuditRow,
  CallOutcome,
  PersistedTool,
  Principal,
  ServerRecord,
  ToolMode,
} from './types.js';
import type { Upstream, UpstreamState } from './upstream.js';

const member: Principal = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'member@example.com',
  role: 'member',
  via: 'api_key',
  apiKeyId: '00000000-0000-4000-8000-000000000002',
  toolMode: 'auto',
  rateLimitPerMin: null,
};
const admin: Principal = { ...member, email: 'admin@example.com', role: 'admin' };

const rules: PolicyRule[] = SEED_POLICIES.map((r, i) => ({
  ...r,
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  createdAt: new Date(2026, 0, 1),
}));

type Call = (name: string, args: Record<string, unknown> | undefined) => Promise<CallOutcome>;
const okCall: Call = async (name) => ({
  outcome: 'ok',
  result: { content: [{ type: 'text', text: `ran ${name}` }], structuredContent: { ran: name } },
});

class FakeUpstream {
  constructor(
    readonly record: ServerRecord,
    private readonly list: Tool[],
    readonly state: UpstreamState,
    readonly call: Call,
  ) {}
  start() {}
  async stop() {}
  tools() {
    return this.list;
  }
}

type Spec = {
  tools?: string[];
  state?: UpstreamState;
  call?: Call;
  record?: Partial<ServerRecord>;
  persisted?: PersistedTool[];
};

const toolDef = (name: string): Tool => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'the id' } } },
});

function setup(specs: Record<string, Spec>) {
  const registry = new Registry({
    log: quietLog,
    createUpstream: (r: ServerRecord) => {
      const s = specs[r.slug] ?? {};
      return new FakeUpstream(
        r,
        (s.tools ?? []).map(toolDef),
        r.enabled ? (s.state ?? 'connected') : 'disabled',
        s.call ?? okCall,
      ) as unknown as Upstream;
    },
  });
  for (const [slug, s] of Object.entries(specs)) {
    registry.apply(
      {
        id: `id-${slug}`,
        slug,
        name: slug,
        url: 'http://x.test/mcp',
        kind: 'external',
        enabled: true,
        approval: 'approved',
        timeoutMs: 15_000,
        protocolMode: 'legacy',
        auth: { type: 'none' },
        ...s.record,
      },
      s.persisted,
    );
  }
  return registry;
}

async function connect(
  specs: Record<string, Spec>,
  o: { principal?: Principal; toolMode?: ToolMode; failAudit?: boolean } = {},
) {
  const registry = setup(specs);
  const audit: AuditRow[] = [];
  const principal = o.principal ?? member;
  const server = createGatewayServer({
    principal,
    toolMode: o.toolMode ?? principal.toolMode,
    router: registry,
    policies: { allows: (role, slug, tool) => evaluatePolicy(rules, role, slug, tool) },
    limiter: unlimited,
    replica: 'r1',
    log: quietLog,
    audit: {
      write: async (row) => {
        audit.push(row);
      },
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'search-test', version: '0.0.0' });
  await client.connect(b);
  return { client, audit, registry };
}

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a protocol error');
    },
    (e: { code: number; message: string }) => ({ code: e.code, message: e.message }),
  );
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}_${i}`);
const searchNames = async (c: Client, query: string, limit?: number) => {
  const r = await c.callTool({ name: 'search_tools', arguments: { query, limit } });
  const found = (r.structuredContent as { tools: Array<{ name: string }> }).tools;
  return found.map((t) => t.name);
};

describe('tools/list in search mode', () => {
  it('lists exactly call_tool and search_tools, sorted', async () => {
    const { client } = await connect({ fx: { tools: ['get_info'] } }, { toolMode: 'search' });
    expect(await names(client)).toEqual(['call_tool', 'search_tools']);
  });

  it('keeps the full list in full mode', async () => {
    const { client } = await connect({ fx: { tools: ['get_info'] } }, { toolMode: 'full' });
    expect(await names(client)).toEqual(['fx__get_info']);
  });

  it('switches auto from the full list at 40 visible tools to the meta-tools at 41', async () => {
    const forty = await connect({ fx: { tools: many('t', 40) } });
    expect(await names(forty.client)).toHaveLength(40);
    const more = await connect({ fx: { tools: many('t', 41) } });
    expect(await names(more.client)).toEqual(['call_tool', 'search_tools']);
  });

  it('counts after policy for auto', async () => {
    // The seed lets a member list/get; create_* is hidden, so 42 tools show as 40.
    const specs = { main: { tools: [...many('get', 40), 'create_a', 'create_b'] } };
    const m = await connect(specs, { principal: member });
    expect(await names(m.client)).toHaveLength(40);
    const a = await connect(specs, { principal: admin });
    expect(await names(a.client)).toEqual(['call_tool', 'search_tools']);
  });

  it('answers a search-mode list with one dead upstream in under 300 ms', async () => {
    const { client } = await connect(
      {
        fx: { tools: ['get_info'] },
        dead: { tools: ['get_x'], state: 'unreachable', call: () => new Promise(() => {}) },
      },
      { toolMode: 'search' },
    );
    const t0 = performance.now();
    await client.listTools();
    expect(performance.now() - t0).toBeLessThan(300);
  });
});

describe('search_tools', () => {
  it('finds a tool and returns structured content plus the same JSON as text', async () => {
    const { client } = await connect({ fx: { tools: ['get_info', 'get_rates'] } });
    const r = await client.callTool({ name: 'search_tools', arguments: { query: 'rates' } });
    const found = r.structuredContent as { tools: Tool[] };
    expect(found.tools.map((t) => t.name)).toEqual(['fx__get_rates']);
    expect(found.tools[0]).toMatchObject({
      description: expect.stringContaining('get_rates'),
      inputSchema: { type: 'object' },
    });
    expect(r.content).toEqual([{ type: 'text', text: JSON.stringify(r.structuredContent) }]);
    expect(r.isError).toBeFalsy();
  });

  it('answers an empty list when nothing matches', async () => {
    const { client } = await connect({ fx: { tools: ['get_info'] } });
    const r = await client.callTool({ name: 'search_tools', arguments: { query: 'zzqqxx' } });
    expect(r.structuredContent).toEqual({ tools: [] });
  });

  it('leaves out tools hidden by policy, pending servers, changed tools and disabled servers', async () => {
    const { client, registry } = await connect({
      main: { tools: ['get_visible', 'create_hidden', 'get_changed'] },
      wait: { tools: ['get_pending'], record: { approval: 'pending' } },
      off: { tools: ['get_disabled'], record: { enabled: false } },
      down: { tools: ['get_down'], state: 'unreachable' },
    });
    registry.setToolStates('id-main', new Map([['get_changed', 'changed']]));
    expect(
      await searchNames(client, 'get create visible hidden changed pending disabled down'),
    ).toEqual(['main__get_visible']);
  });

  it('refuses bad input with -32602 and audits bad_request', async () => {
    const { client, audit } = await connect({ fx: { tools: ['get_info'] } });
    for (const args of [{ query: 'x', limit: 11 }, { query: '' }, {}, { query: 5 }]) {
      await expect(
        client.callTool({ name: 'search_tools', arguments: args }),
      ).rejects.toMatchObject({ code: -32602 });
    }
    expect(audit).toHaveLength(4);
    expect(audit.every((r) => r.outcome === 'bad_request' && r.metaTool === 'search_tools')).toBe(
      true,
    );
  });

  it('writes one audit row with an empty server and no query text', async () => {
    const { client, audit } = await connect({ fx: { tools: ['get_info'] } });
    await client.callTool({ name: 'search_tools', arguments: { query: 'secret-query-text' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      serverId: null,
      serverSlug: '',
      toolName: 'search_tools',
      exposedName: 'search_tools',
      metaTool: 'search_tools',
      outcome: 'ok',
      errorMessage: null,
      userId: member.userId,
      argsSha256: sha256Hex(canonicalJson({ query: 'secret-query-text' })),
    });
    expect(JSON.stringify(audit)).not.toContain('secret-query-text');
  });
});

describe('call_tool', () => {
  it('runs the tool and audits the real server, tool and exposed name', async () => {
    const call = vi.fn(okCall);
    const { client, audit } = await connect({ fx: { tools: ['get_info'], call } });
    const r = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'fx__get_info', arguments: { b: 2, a: 1 } },
    });
    expect(r.structuredContent).toEqual({ ran: 'get_info' });
    expect(call).toHaveBeenCalledWith(
      'get_info',
      { b: 2, a: 1 },
      expect.anything(),
      expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      outcome: 'ok',
      serverId: 'id-fx',
      serverSlug: 'fx',
      toolName: 'get_info',
      exposedName: 'fx__get_info',
      metaTool: 'call_tool',
      argsSha256: sha256Hex(canonicalJson({ a: 1, b: 2 })),
    });
  });

  it('answers a hidden tool with the same error as a direct call', async () => {
    const call = vi.fn(okCall);
    const { client, audit } = await connect({ main: { tools: ['create_hidden'], call } });
    const direct = await rejection(client.callTool({ name: 'main__create_hidden', arguments: {} }));
    const viaMeta = await rejection(
      client.callTool({ name: 'call_tool', arguments: { name: 'main__create_hidden' } }),
    );
    expect(direct).toEqual({ code: -32602, message: expect.stringContaining('Unknown tool') });
    expect(viaMeta).toEqual(direct);
    expect(call).not.toHaveBeenCalled();
    expect(audit.map((r) => [r.outcome, r.metaTool])).toEqual([
      ['denied', null],
      ['denied', 'call_tool'],
    ]);
    expect(audit[1]).toMatchObject({ serverSlug: 'main', exposedName: 'main__create_hidden' });
  });

  it('treats an unknown name as bad_request', async () => {
    const { client, audit } = await connect({ fx: { tools: ['get_info'] } });
    await expect(
      client.callTool({ name: 'call_tool', arguments: { name: 'nope__x' } }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('Unknown tool: nope__x'),
    });
    expect(audit[0]).toMatchObject({ outcome: 'bad_request', metaTool: 'call_tool' });
  });

  it('refuses bad call_tool input with -32602', async () => {
    const { client, audit } = await connect({ fx: { tools: ['get_info'] } });
    for (const args of [{}, { name: 5 }, { name: 'fx__get_info', arguments: 'x' }]) {
      await expect(client.callTool({ name: 'call_tool', arguments: args })).rejects.toMatchObject({
        code: -32602,
      });
    }
    expect(audit.map((r) => [r.outcome, r.metaTool])).toEqual([
      ['bad_request', 'call_tool'],
      ['bad_request', 'call_tool'],
      ['bad_request', 'call_tool'],
    ]);
  });

  it('gives the direct-call tool errors for a disabled server', async () => {
    const persisted: PersistedTool[] = [
      { name: 'get_x', exposedName: 'off__get_x', state: 'active', definitionHash: 'h' },
    ];
    const { client, audit } = await connect({
      off: { record: { enabled: false }, persisted },
    });
    const direct = await client.callTool({ name: 'off__get_x', arguments: {} });
    const viaMeta = await client.callTool({ name: 'call_tool', arguments: { name: 'off__get_x' } });
    expect(viaMeta).toEqual(direct);
    expect(viaMeta).toMatchObject({ isError: true, content: [{ text: 'Server off is disabled' }] });
    expect(audit.map((r) => [r.outcome, r.metaTool])).toEqual([
      ['disabled', null],
      ['disabled', 'call_tool'],
    ]);
  });

  it('gives the direct-call tool errors and outcomes for timeout and unreachable upstreams', async () => {
    for (const outcome of ['timeout', 'unreachable', 'upstream_error'] as const) {
      const call: Call = async () => ({ outcome, message: `upstream said ${outcome}` });
      const { client, audit } = await connect({ fx: { tools: ['get_info'], call } });
      const direct = await client.callTool({ name: 'fx__get_info', arguments: {} });
      const viaMeta = await client.callTool({
        name: 'call_tool',
        arguments: { name: 'fx__get_info' },
      });
      expect(viaMeta).toEqual(direct);
      expect(viaMeta.isError).toBe(true);
      expect(audit.map((r) => r.outcome)).toEqual([outcome, outcome]);
    }
  });

  it('treats search_tools and call_tool as unknown inner names', async () => {
    const { client, audit } = await connect({ fx: { tools: ['get_info'] } });
    for (const inner of ['search_tools', 'call_tool']) {
      await expect(
        client.callTool({
          name: 'call_tool',
          arguments: { name: inner, arguments: { query: 'x' } },
        }),
      ).rejects.toMatchObject({ code: -32602, message: `Unknown tool: ${inner}` });
    }
    expect(audit.every((r) => r.outcome === 'bad_request' && r.metaTool === 'call_tool')).toBe(
      true,
    );
  });
});

describe('meta-tools and direct calls across modes', () => {
  it('runs the meta-tools in full mode', async () => {
    const { client } = await connect({ fx: { tools: ['get_info'] } }, { toolMode: 'full' });
    expect(await searchNames(client, 'info')).toEqual(['fx__get_info']);
    const r = await client.callTool({ name: 'call_tool', arguments: { name: 'fx__get_info' } });
    expect(r.structuredContent).toEqual({ ran: 'get_info' });
  });

  it('still routes a direct call by exposed name in search mode', async () => {
    const { client, audit } = await connect(
      { fx: { tools: ['get_info'] } },
      { toolMode: 'search' },
    );
    const r = await client.callTool({ name: 'fx__get_info', arguments: {} });
    expect(r.structuredContent).toEqual({ ran: 'get_info' });
    expect(audit[0]).toMatchObject({ outcome: 'ok', metaTool: null });
  });
});
