import { Client, InMemoryTransport, type Tool } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from './canonical.js';
import { auditVersion, createGatewayServer } from './mcp.js';
import type { Route, Router } from './registry.js';
import { captureLog, quietLog } from './test-helpers.js';
import type { AuditRow, CallOutcome, Log, Principal, ServerRecord } from './types.js';

const principal: Principal = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'dev@example.com',
  role: 'member',
  via: 'api_key',
  apiKeyId: '00000000-0000-4000-8000-000000000002',
};

type Call = (
  name: string,
  args: Record<string, unknown> | undefined,
  signal: AbortSignal,
) => Promise<CallOutcome>;

function route(slug: string, call: Call, enabled = true): Route {
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
  return { upstream: { record, call }, toolName: 'tool' };
}

async function connect(
  routes: Record<string, Route>,
  o: { tools?: Tool[]; log?: Log; failAudit?: boolean } = {},
) {
  const audit: AuditRow[] = [];
  const router: Router = { list: () => o.tools ?? [], resolve: (n) => routes[n] };
  const server = createGatewayServer({
    principal,
    router,
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
});
