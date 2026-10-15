import { Client, InMemoryTransport, type Tool } from '@modelcontextprotocol/client';
import { SEED_POLICIES, evaluatePolicy, type PolicyRule } from '@woo/core';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from './canonical.js';
import { auditVersion, createGatewayServer } from './mcp.js';
import type { Route, Router } from './registry.js';
import type { CallLimiter } from './rate-limit.js';
import { captureLog, quietLog, unlimited } from './test-helpers.js';
import type { AuditRow, CallOutcome, Log, Principal, ServerRecord } from './types.js';

const principal: Principal = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'dev@example.com',
  role: 'member',
  via: 'api_key',
  apiKeyId: '00000000-0000-4000-8000-000000000002',
  toolMode: 'full',
  rateLimitPerMin: null,
};

type Call = (
  name: string,
  args: Record<string, unknown> | undefined,
  signal: AbortSignal,
  traceparent?: string,
) => Promise<CallOutcome>;

function route(slug: string, call: Call, enabled = true, toolName = 'tool'): Route {
  const record: ServerRecord = {
    id: `id-${slug}`,
    slug,
    name: slug,
    url: 'http://x.test/mcp',
    kind: 'external',
    enabled,
    approval: 'approved',
    timeoutMs: 15_000,
    protocolMode: 'legacy',
    auth: { type: 'none' },
  };
  return { upstream: { record, call }, toolName };
}

const seeded: PolicyRule[] = SEED_POLICIES.map((r, i) => ({
  ...r,
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  createdAt: new Date(2026, 0, 1),
}));
// Nothing hidden: the tests that are not about policy do not depend on the seed.
const allowAll = { allows: () => true };

async function connect(
  routes: Record<string, Route>,
  o: {
    tools?: Tool[];
    log?: Log;
    failAudit?: boolean;
    rules?: PolicyRule[];
    principal?: Principal;
    limiter?: CallLimiter;
    requestId?: string;
  } = {},
) {
  const audit: AuditRow[] = [];
  const router: Router = {
    // Exposed names are <slug>__<tool>, as the real registry builds them.
    list: (keep) =>
      (o.tools ?? []).filter((t) => {
        const [slug = '', ...rest] = t.name.split('__');
        return keep ? keep(slug, rest.join('__')) : true;
      }),
    resolve: (n) => routes[n],
  };
  const rules = o.rules;
  const server = createGatewayServer({
    principal: o.principal ?? principal,
    toolMode: (o.principal ?? principal).toolMode,
    policies: rules
      ? { allows: (role, slug, tool) => evaluatePolicy(rules, role, slug, tool) }
      : allowAll,
    router,
    limiter: o.limiter ?? unlimited,
    requestId: o.requestId,
    replica: 'r1',
    log: o.log ?? quietLog,
    audit: {
      write: async (row) => {
        if (o.failAudit)
          throw Object.assign(new Error('insert into "audit_events" values ($1)'), {
            code: '57P01',
          });
        audit.push(row);
      },
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'mcp-test', version: '0.0.0' });
  await client.connect(b);
  return { client, audit };
}

const okCall: Call = async () => ({
  outcome: 'ok',
  result: { content: [{ type: 'text', text: 'hi' }], structuredContent: { a: 1 } },
});

describe('createGatewayServer', () => {
  it('lists what the router lists', async () => {
    const tools: Tool[] = [
      { name: 'fx__get_info', description: '[FX] info', inputSchema: { type: 'object' } },
    ];
    const { client } = await connect({}, { tools });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['fx__get_info']);
  });

  it('answers -32602 for an unknown tool and audits bad_request', async () => {
    const { client, audit } = await connect({});
    await expect(client.callTool({ name: 'nope__x', arguments: {} })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('Unknown tool: nope__x'),
    });
    expect(audit).toEqual([
      expect.objectContaining({
        outcome: 'bad_request',
        serverId: null,
        serverSlug: 'nope',
        toolName: 'x',
        exposedName: 'nope__x',
        errorMessage: 'unknown tool',
      }),
    ]);
  });

  it('refuses a disabled server without calling it', async () => {
    const call = vi.fn(okCall);
    const { client, audit } = await connect({ fx__tool: route('fx', call, false) });
    const r = await client.callTool({ name: 'fx__tool', arguments: {} });
    expect(r).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Server fx is disabled' }],
    });
    expect(call).not.toHaveBeenCalled();
    expect(audit[0]).toMatchObject({ outcome: 'disabled', errorMessage: 'Server fx is disabled' });
  });

  it('passes results through and audits ok with the canonical args hash', async () => {
    const { client, audit } = await connect({ fx__tool: route('fx', okCall) });
    const r = await client.callTool({ name: 'fx__tool', arguments: { b: 2, a: 1 } });
    expect(r.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(r.structuredContent).toEqual({ a: 1 });
    expect(r.isError).toBeFalsy();
    expect(audit[0]).toMatchObject({
      outcome: 'ok',
      serverId: 'id-fx',
      serverSlug: 'fx',
      toolName: 'tool',
      exposedName: 'fx__tool',
      userId: principal.userId,
      userEmail: principal.email,
      via: 'api_key',
      apiKeyId: principal.apiKeyId,
      replica: 'r1',
      errorMessage: null,
      argsSha256: sha256Hex(canonicalJson({ a: 1, b: 2 })),
    });
    expect(Number.isInteger(audit[0]!.durationMs)).toBe(true);
  });

  it('returns structured content as received, without adding text', async () => {
    const call: Call = async () => ({
      outcome: 'ok',
      result: { content: [], structuredContent: { rate: 0.0103 } },
    });
    const { client } = await connect({ fx__tool: route('fx', call) });
    const r = await client.callTool({ name: 'fx__tool', arguments: {} });
    expect(r.content).toEqual([]);
    expect(r.structuredContent).toEqual({ rate: 0.0103 });
  });

  it('caps error_message at 500 characters', async () => {
    const call: Call = async () => ({ outcome: 'upstream_error', message: 'e'.repeat(600) });
    const { client, audit } = await connect({ fx__tool: route('fx', call) });
    await client.callTool({ name: 'fx__tool', arguments: {} });
    expect(audit[0]?.errorMessage).toHaveLength(500);
  });

  it('returns an upstream isError result unchanged and audits tool_error', async () => {
    const call: Call = async () => ({
      outcome: 'tool_error',
      result: { content: [{ type: 'text', text: 'bad' }], isError: true },
    });
    const { client, audit } = await connect({ fx__tool: route('fx', call) });
    expect(await client.callTool({ name: 'fx__tool', arguments: {} })).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'bad' }],
    });
    expect(audit[0]?.outcome).toBe('tool_error');
  });

  it.each(['timeout', 'unreachable', 'upstream_error'] as const)(
    'turns %s into a tool error',
    async (outcome) => {
      const call: Call = async () => ({ outcome, message: `Server fx says ${outcome}` });
      const { client, audit } = await connect({ fx__tool: route('fx', call) });
      expect(await client.callTool({ name: 'fx__tool', arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: `Server fx says ${outcome}` }],
      });
      expect(audit[0]).toMatchObject({ outcome, errorMessage: `Server fx says ${outcome}` });
    },
  );

  it('hands the request abort signal to the upstream call', async () => {
    const call = vi.fn(okCall);
    const { client } = await connect({ fx__tool: route('fx', call) });
    await client.callTool({ name: 'fx__tool', arguments: {} });
    expect(call.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  });

  it('still answers when the audit write fails and logs only the code', async () => {
    const log = captureLog();
    const { client } = await connect({ fx__tool: route('fx', okCall) }, { log, failAudit: true });
    expect((await client.callTool({ name: 'fx__tool', arguments: {} })).isError).toBeFalsy();
    expect(log.lines.join('\n')).toContain('57P01');
    expect(log.lines.join('\n')).not.toContain('insert into');
  });

  it('cuts very long unknown names in the error and the audit row', async () => {
    const { client, audit } = await connect({});
    const name = 'x'.repeat(10_000);
    const err = (await client.callTool({ name, arguments: {} }).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain(`Unknown tool: ${'x'.repeat(128)}`);
    expect(err.message).not.toContain('x'.repeat(129));
    expect(audit[0]?.exposedName).toHaveLength(128);
  });

  it('answers bad_request and still audits when the arguments nest too deep', async () => {
    const call = vi.fn(okCall);
    const { client, audit } = await connect({ fx__tool: route('fx', call) });
    let deep: unknown = {};
    for (let i = 0; i < 10_000; i++) deep = [deep];
    await expect(client.callTool({ name: 'fx__tool', arguments: { deep } })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('nested'),
    });
    expect(call).not.toHaveBeenCalled();
    expect(audit).toEqual([
      expect.objectContaining({
        outcome: 'bad_request',
        serverSlug: 'fx',
        errorMessage: 'arguments nested too deeply',
        argsSha256: null,
      }),
    ]);
  });

  it('accepts arguments nested exactly 64 levels deep', async () => {
    const { client, audit } = await connect({ fx__tool: route('fx', okCall) });
    let deep: unknown = 1;
    for (let i = 0; i < 63; i++) deep = [deep];
    await client.callTool({ name: 'fx__tool', arguments: { deep } });
    expect(audit[0]).toMatchObject({ outcome: 'ok' });
    expect(audit[0]?.argsSha256).toHaveLength(64);
  });

  it('cuts the protocol version stored in the audit row to 32 characters', () => {
    expect(auditVersion('2025-11-25' + 'x'.repeat(5000))).toHaveLength(32);
    expect(auditVersion('2025-11-25')).toBe('2025-11-25');
    expect(auditVersion(null)).toBeNull();
    expect(auditVersion('')).toBeNull();
  });

  describe('rate limit', () => {
    // Allows `n` checks, then refuses with 42 s. `checks` shows what was counted.
    const limitAfter = (n: number) => {
      const check = vi.fn(async () => ({
        allowed: check.mock.calls.length <= n,
        retryInSeconds: 42,
      }));
      return { check } satisfies CallLimiter;
    };
    const tool = (name: string): Tool => ({
      name,
      description: name,
      inputSchema: { type: 'object' },
    });

    it('answers the call after the limit with a tool error and audits rate_limited', async () => {
      const call = vi.fn(okCall);
      const limiter = limitAfter(1);
      const { client, audit } = await connect({ fx__tool: route('fx', call) }, { limiter });
      await client.callTool({ name: 'fx__tool', arguments: {} });
      const r = await client.callTool({ name: 'fx__tool', arguments: {} });
      expect(r).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'Rate limit exceeded, retry in 42 s' }],
      });
      expect(call).toHaveBeenCalledOnce();
      expect(audit.map((a) => a.outcome)).toEqual(['ok', 'rate_limited']);
      expect(audit[1]).toMatchObject({
        serverSlug: 'fx',
        errorMessage: 'Rate limit exceeded, retry in 42 s',
      });
    });

    it('counts call_tool once and limits it the same way', async () => {
      const call = vi.fn(okCall);
      const limiter = limitAfter(1);
      const { client, audit } = await connect({ fx__tool: route('fx', call) }, { limiter });
      const via = () => client.callTool({ name: 'call_tool', arguments: { name: 'fx__tool' } });
      await via();
      expect(limiter.check).toHaveBeenCalledTimes(1);
      expect(await via()).toMatchObject({ isError: true });
      expect(audit.map((a) => [a.metaTool, a.outcome])).toEqual([
        ['call_tool', 'ok'],
        ['call_tool', 'rate_limited'],
      ]);
    });

    it('counts search_tools and limits it', async () => {
      const limiter = limitAfter(1);
      const { client, audit } = await connect({}, { tools: [tool('fx__a')], limiter });
      await client.callTool({ name: 'search_tools', arguments: { query: 'a' } });
      const r = await client.callTool({ name: 'search_tools', arguments: { query: 'a' } });
      expect(r).toMatchObject({ isError: true });
      expect(audit.map((a) => a.outcome)).toEqual(['ok', 'rate_limited']);
    });

    it('never limits tools/list', async () => {
      const limiter = limitAfter(0);
      const { client } = await connect({}, { tools: [tool('fx__a')], limiter });
      for (let i = 0; i < 3; i++) await client.listTools();
      expect(limiter.check).not.toHaveBeenCalled();
    });

    it('does not count a hidden tool or an unknown name', async () => {
      const limiter = limitAfter(0);
      const { client } = await connect(
        { main__create_product: route('main', okCall, true, 'create_product') },
        { rules: seeded, limiter },
      );
      await expect(
        client.callTool({ name: 'main__create_product', arguments: {} }),
      ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining('Unknown tool') });
      await expect(client.callTool({ name: 'nope__x', arguments: {} })).rejects.toMatchObject({
        code: -32602,
      });
      expect(limiter.check).not.toHaveBeenCalled();
    });

    it('says rate limited for a disabled server when over the limit', async () => {
      const { client, audit } = await connect(
        { fx__tool: route('fx', okCall, false) },
        { limiter: limitAfter(0) },
      );
      const r = await client.callTool({ name: 'fx__tool', arguments: {} });
      expect(r).toMatchObject({ content: [{ text: 'Rate limit exceeded, retry in 42 s' }] });
      expect(audit[0]?.outcome).toBe('rate_limited');
    });

    it('lets the call through and warns with a code only when the limiter throws', async () => {
      const log = captureLog();
      const limiter: CallLimiter = {
        check: async () => {
          throw Object.assign(new Error('insert into "rate_counters" values ($1)'), {
            code: '57P01',
          });
        },
      };
      const call = vi.fn(okCall);
      const { client, audit } = await connect({ fx__tool: route('fx', call) }, { limiter, log });
      expect(await client.callTool({ name: 'fx__tool', arguments: {} })).not.toHaveProperty(
        'isError',
      );
      expect(call).toHaveBeenCalledOnce();
      expect(audit[0]?.outcome).toBe('ok');
      const warns = log.lines.filter((l) => l.includes('"level":"warn"'));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('57P01');
      expect(warns[0]).not.toContain('rate_counters');
    });

    it('lets the call through after a 2 s stall', async () => {
      const log = captureLog();
      const limiter: CallLimiter = { check: () => new Promise(() => {}) };
      const call = vi.fn(okCall);
      const { client } = await connect({ fx__tool: route('fx', call) }, { limiter, log });
      const t0 = Date.now();
      await client.callTool({ name: 'fx__tool', arguments: {} });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
      expect(call).toHaveBeenCalledOnce();
      expect(log.lines.some((l) => l.includes('ETIMEDOUT'))).toBe(true);
    }, 10_000);
  });

  describe('role policy', () => {
    const tool = (name: string): Tool => ({ name, inputSchema: { type: 'object' } });
    const tools = [
      tool('fx__get_info'),
      tool('main__list_orders'),
      tool('main__create_product'),
      tool('gh__create_issue'),
    ];
    const routes = {
      main__create_product: route('main', okCall, true, 'create_product'),
      main__list_orders: route('main', okCall, true, 'list_orders'),
    };

    it('hides tools from a member that the seeded rules do not allow', async () => {
      const { client } = await connect(routes, { tools, rules: seeded });
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
        'fx__get_info',
        'main__list_orders',
      ]);
    });

    it('lists every tool for an admin', async () => {
      const { client } = await connect(routes, {
        tools,
        rules: seeded,
        principal: { ...principal, role: 'admin' },
      });
      expect((await client.listTools()).tools).toHaveLength(4);
    });

    it('filters an agent principal by its user role', async () => {
      const { client } = await connect(routes, {
        tools,
        rules: seeded,
        principal: { ...principal, via: 'agent', apiKeyId: null },
      });
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(
        'main__create_product',
      );
    });

    it('answers a hidden tool exactly like a missing one', async () => {
      const call = vi.fn(okCall);
      const { client } = await connect(
        { main__create_product: route('main', call, true, 'create_product') },
        { rules: seeded },
      );
      const fail = async (name: string) => {
        try {
          await client.callTool({ name, arguments: {} });
        } catch (err) {
          const e = err as { code: number; message: string; data?: unknown };
          return JSON.stringify({
            code: e.code,
            message: e.message.replace(name, '<name>'),
            data: e.data,
          });
        }
        throw new Error('expected a protocol error');
      };
      const hidden = await fail('main__create_product');
      const missing = await fail('main__does_not_exist');
      expect(hidden).toBe(missing);
      expect(JSON.parse(hidden)).toMatchObject({
        code: -32602,
        message: expect.stringContaining('Unknown tool'),
      });
      expect(call).not.toHaveBeenCalled();
    });

    it('audits a hidden tool as denied with server and tool filled in', async () => {
      const { client, audit } = await connect(
        { main__create_product: route('main', okCall, true, 'create_product') },
        { rules: seeded },
      );
      await client.callTool({ name: 'main__create_product', arguments: {} }).catch(() => {});
      expect(audit).toEqual([
        expect.objectContaining({
          outcome: 'denied',
          serverId: 'id-main',
          serverSlug: 'main',
          toolName: 'create_product',
          exposedName: 'main__create_product',
        }),
      ]);
    });

    it('audits a missing tool as bad_request', async () => {
      const { client, audit } = await connect({}, { rules: seeded });
      await client.callTool({ name: 'main__nope', arguments: {} }).catch(() => {});
      expect(audit.map((a) => a.outcome)).toEqual(['bad_request']);
    });

    it('does not reveal that a hidden tool sits on a disabled server', async () => {
      const { client, audit } = await connect(
        { main__create_product: route('main', okCall, false, 'create_product') },
        { rules: seeded },
      );
      await expect(
        client.callTool({ name: 'main__create_product', arguments: {} }),
      ).rejects.toMatchObject({
        code: -32602,
      });
      expect(audit.map((a) => a.outcome)).toEqual(['denied']);
    });

    it('lets an allowed member call through', async () => {
      const call = vi.fn(okCall);
      const { client, audit } = await connect(
        { main__list_orders: route('main', call, true, 'list_orders') },
        { rules: seeded },
      );
      await client.callTool({ name: 'main__list_orders', arguments: {} });
      expect(call).toHaveBeenCalledOnce();
      expect(audit.map((a) => a.outcome)).toEqual(['ok']);
    });
  });
});

describe('trace context and the call log line', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const CLIENT_TP = `00-${TRACE}-00f067aa0ba902b7-01`;

  it("sends the upstream the client's trace id with a new parent id", async () => {
    const seen: Array<string | undefined> = [];
    const { client } = await connect({
      fx__tool: route('fx', async (_n, _a, _s, tp) => {
        seen.push(tp);
        return okCall('x', {}, _s);
      }),
    });
    await client.callTool({
      name: 'fx__tool',
      arguments: {},
      _meta: { traceparent: CLIENT_TP },
    });
    expect(seen[0]).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));
    expect(seen[0]).not.toContain('00f067aa0ba902b7');
  });

  it.each([
    ['an invalid traceparent', { traceparent: `00-${TRACE.toUpperCase()}-00f067aa0ba902b7-01` }],
    ['no traceparent', {}],
  ])('starts a new trace for %s', async (_name, meta) => {
    const seen: Array<string | undefined> = [];
    const { client } = await connect({
      fx__tool: route('fx', async (_n, _a, s, tp) => {
        seen.push(tp);
        return okCall('x', {}, s);
      }),
    });
    await client.callTool({ name: 'fx__tool', arguments: {}, _meta: meta });
    expect(seen[0]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(seen[0]).not.toContain(TRACE.toUpperCase());
  });

  it('does not forward tracestate or any other client _meta key', async () => {
    const seen: Array<string | undefined> = [];
    const { client } = await connect({
      fx__tool: route('fx', async (_n, _a, s, tp) => {
        seen.push(tp);
        return okCall('x', {}, s);
      }),
    });
    await client.callTool({
      name: 'fx__tool',
      arguments: {},
      _meta: { traceparent: CLIENT_TP, tracestate: 'v=secret-state', 'x-user': 'someone' },
    });
    // The only thing handed to an upstream call is one traceparent string.
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain('secret-state');
    expect(seen[0]).not.toContain('someone');
  });

  it('keeps the trace for call_tool inner calls', async () => {
    const seen: Array<string | undefined> = [];
    const { client } = await connect({
      fx__tool: route('fx', async (_n, _a, s, tp) => {
        seen.push(tp);
        return okCall('x', {}, s);
      }),
    });
    await client.callTool({
      name: 'call_tool',
      arguments: { name: 'fx__tool', arguments: {} },
      _meta: { traceparent: CLIENT_TP },
    });
    expect(seen[0]).toMatch(new RegExp(`^00-${TRACE}-`));
  });

  it('uses the request id for the audit row', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const { client, audit } = await connect({ fx__tool: route('fx', okCall) }, { requestId: id });
    await client.callTool({ name: 'fx__tool', arguments: {} });
    expect(audit[0]?.requestId).toBe(id);
  });

  it('logs one info line per tools/call with ids and no arguments', async () => {
    const log = captureLog();
    const { client } = await connect(
      { fx__tool: route('fx', okCall) },
      { log, requestId: '11111111-2222-4333-8444-555555555555' },
    );
    await client.callTool({
      name: 'fx__tool',
      arguments: { secret: 'argument-value-42' },
      _meta: { traceparent: CLIENT_TP },
    });
    const lines = log.lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'tool call');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      request_id: '11111111-2222-4333-8444-555555555555',
      trace_id: TRACE,
      user_id: principal.userId,
      server: 'fx',
      tool: 'tool',
      outcome: 'ok',
      ms: expect.any(Number),
    });
    const text = log.lines.join('\n');
    expect(text).not.toContain('argument-value-42');
    expect(text).not.toContain(principal.email);
  });

  it('logs _unknown instead of echoing an unknown name, and _search for search_tools', async () => {
    const log = captureLog();
    const { client } = await connect({}, { log });
    await client.callTool({ name: 'evil__"inject', arguments: {} }).catch(() => {});
    await client.callTool({ name: 'search_tools', arguments: { query: 'x' } });
    const lines = log.lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'tool call');
    expect(lines.map((l) => [l.server, l.tool])).toEqual([
      ['_unknown', '_unknown'],
      ['_search', 'search_tools'],
    ]);
    expect(log.lines.join('\n')).not.toContain('inject');
  });
});
