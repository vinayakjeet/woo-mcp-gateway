import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { startMcpHttpServer } from '@woo/core/mcp-http';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { buildGatewayApp } from './app.js';
import { Registry } from './registry.js';
import type { AuditRow, Log, Principal, ServerRecord } from './types.js';

const TOKEN = 'upstream-token-not-a-secret';
const SILENT_TIMEOUT_MS = 1000;
const quiet: Log = { info: () => {}, warn: () => {}, error: () => {} };
const principal: Principal = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'dev@example.com',
  role: 'admin',
  via: 'api_key',
  apiKeyId: '00000000-0000-4000-8000-000000000002',
};

type Fake = Awaited<ReturnType<typeof startMcpHttpServer>>;

function fakeUpstream(
  name: string,
  tool: string,
  answer: (signal: AbortSignal, tag: string) => Promise<string>,
): Promise<Fake> {
  return startMcpHttpServer({
    port: 0,
    token: TOKEN,
    ready: async () => true,
    createServer: () => {
      const s = new McpServer({ name, version: '0.0.0' });
      s.registerTool(
        tool,
        { description: `${tool} tool`, inputSchema: z.object({ tag: z.string().optional() }) },
        async ({ tag }, ctx) => ({
          content: [{ type: 'text', text: await answer(ctx.mcpReq.signal, tag ?? '') }],
        }),
      );
      return s;
    },
  });
}

function record(id: string, slug: string, base: string, timeoutMs: number): ServerRecord {
  return {
    id,
    slug,
    name: slug,
    url: `${base}/mcp`,
    kind: 'external',
    enabled: true,
    approval: 'approved',
    timeoutMs,
    protocolMode: 'auto',
    auth: { type: 'bearer', secret: TOKEN },
  };
}

describe.each(['legacy', 'auto'] as const)('gateway isolation, %s client era', (mode) => {
  const audit: AuditRow[] = [];
  // Tagged, because the upstream aborts of earlier tests' timed-out calls can land late under load.
  const silentStarts: string[] = [];
  const silentAborts: { tag: string; at: number }[] = [];
  let fast: Fake;
  let silent: Fake;
  let registry: Registry;
  let app: FastifyInstance;
  let url: URL;

  beforeAll(async () => {
    fast = await fakeUpstream('fast', 'echo', async () => {
      await sleep(50);
      return 'fast answer';
    });
    // Never answers. Records each call and when the gateway gives up on it, so cancellation can be checked.
    silent = await fakeUpstream('silent', 'wait', (signal, tag) => {
      silentStarts.push(tag);
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          silentAborts.push({ tag, at: Date.now() });
          reject(new Error('aborted'));
        });
      });
    });
    registry = new Registry({ log: quiet });
    registry.apply(record('00000000-0000-4000-8000-0000000000f1', 'fast', fast.url, 15_000));
    registry.apply(
      record('00000000-0000-4000-8000-0000000000f2', 'silent', silent.url, SILENT_TIMEOUT_MS),
    );
    app = buildGatewayApp({
      router: registry,
      policies: { allows: () => true },
      audit: { write: async (row) => void audit.push(row) },
      authenticate: async (h) => (h === 'Bearer good' ? principal : null),
      replica: 'test-replica',
      allowedOrigins: [],
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
    await vi.waitFor(() => expect(registry.list()).toHaveLength(2), {
      timeout: 5000,
      interval: 20,
    });
  });

  // Optional chaining: while the stubs throw, setup stops half way and teardown must not mask that error.
  afterAll(async () => {
    await app?.close();
    await registry?.close();
    await fast?.close();
    await silent?.close();
  });

  async function connect(): Promise<Client> {
    const c = new Client(
      { name: 'isolation-test', version: '0.0.0' },
      { versionNegotiation: { mode } },
    );
    await c.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: 'Bearer good' } },
      }),
    );
    return c;
  }

  it('lists both servers from memory in under 300 ms while a call hangs', async () => {
    const c = await connect();
    const hanging = c.callTool({ name: 'silent__wait', arguments: {} });
    await sleep(50);
    const t0 = performance.now();
    const { tools } = await c.listTools(undefined, { cacheMode: 'bypass' });
    expect(performance.now() - t0).toBeLessThan(300);
    expect(tools.map((t) => t.name)).toEqual(['fast__echo', 'silent__wait']);
    await hanging;
    await c.close();
  });

  it('fails the silent call with the configured timeout error', async () => {
    const c = await connect();
    const t0 = performance.now();
    const r = await c.callTool({ name: 'silent__wait', arguments: {} });
    const ms = performance.now() - t0;
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: 'text', text: 'Server silent did not answer within 1 s' }]);
    expect(ms).toBeGreaterThanOrEqual(SILENT_TIMEOUT_MS - 50);
    expect(ms).toBeLessThan(SILENT_TIMEOUT_MS + 700);
    expect(audit.filter((a) => a.exposedName === 'silent__wait').at(-1)).toMatchObject({
      serverSlug: 'silent',
      toolName: 'wait',
      outcome: 'timeout',
      errorMessage: 'Server silent did not answer within 1 s',
      replica: 'test-replica',
      userEmail: 'dev@example.com',
      protocolVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    await c.close();
  });

  it('keeps the fast server answering while the silent one hangs', async () => {
    const c = await connect();
    let settled = false;
    // Two hanging calls: with the two above that makes four timeouts, one short of opening the breaker.
    const hanging = Promise.all(
      [1, 2].map(() => c.callTool({ name: 'silent__wait', arguments: {} })),
    ).finally(() => {
      settled = true;
    });
    await sleep(50);
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const r = await c.callTool({ name: 'fast__echo', arguments: {} });
      expect(performance.now() - t0).toBeLessThan(300);
      expect(r.isError).toBeFalsy();
      expect(r.content).toEqual([{ type: 'text', text: 'fast answer' }]);
    }
    expect(settled).toBe(false);
    for (const r of await hanging) expect(r.isError).toBe(true);
    expect(audit.filter((a) => a.exposedName === 'fast__echo' && a.outcome === 'ok')).toHaveLength(
      3,
    );
    await c.close();
  });

  // A raw 2025-era POST, so closing it closes exactly the stream the gateway is answering on.
  it.runIf(mode === 'legacy')(
    'aborts the upstream call when the client closes the stream',
    async () => {
      const tag = 'cancel';
      const ac = new AbortController();
      const res = fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer good',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'silent__wait', arguments: { tag } },
        }),
      }).catch(() => undefined);
      // Close only once the upstream holds the call; a fixed sleep can lose that race under load.
      await vi.waitFor(() => expect(silentStarts).toContain(tag), { timeout: 3000, interval: 10 });
      const t0 = Date.now();
      ac.abort();
      await res;
      await vi.waitFor(() => expect(silentAborts.some((a) => a.tag === tag)).toBe(true), {
        timeout: 3000,
        interval: 10,
      });
      // The gateway's own 1 s timeout would also abort the upstream; the time tells the two apart.
      expect(silentAborts.find((a) => a.tag === tag)!.at - t0).toBeLessThan(
        SILENT_TIMEOUT_MS - 200,
      );
      await vi.waitFor(() =>
        expect(audit).toContainEqual(
          expect.objectContaining({
            exposedName: 'silent__wait',
            outcome: 'upstream_error',
            errorMessage: 'cancelled by client',
          }),
        ),
      );
    },
    10_000,
  );
});
