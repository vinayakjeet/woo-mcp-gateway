import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatewayApp, type GatewayAppOptions } from './app.js';
import { createGatewayServer } from './mcp.js';
import type { Router } from './registry.js';
import { unlimited } from './test-helpers.js';
import type { Principal } from './types.js';

const principal: Principal = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'dev@example.com',
  role: 'admin',
  via: 'api_key',
  apiKeyId: null,
  toolMode: 'full',
  rateLimitPerMin: null,
};
const router: Router = {
  list: () => [{ name: 'fx__get_info', description: '[FX] info', inputSchema: { type: 'object' } }],
  resolve: () => undefined,
};
const listBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

let app: FastifyInstance;
let base: string;

async function start(
  authenticate = async (h?: string) => (h === 'Bearer good' ? principal : null),
  createServer?: GatewayAppOptions['createServer'],
) {
  const a = buildGatewayApp({
    router,
    policies: { allows: () => true },
    audit: { write: async () => {} },
    limiter: unlimited,
    authenticate,
    replica: 'gw-test-0',
    allowedOrigins: ['http://app.example.test'],
    createServer,
  });
  await a.listen({ host: '127.0.0.1', port: 0 });
  return { a, url: `http://127.0.0.1:${(a.server.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  ({ a: app, url: base } = await start());
});
afterAll(() => app.close());

function post(body: string, headers: Record<string, string | undefined> = {}) {
  const h: Record<string, string> = {};
  const all: Record<string, string | undefined> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: 'Bearer good',
    'mcp-protocol-version': '2025-11-25',
    ...headers,
  };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) h[k] = v;
  return fetch(`${base}/mcp`, { method: 'POST', headers: h, body });
}

async function rpcBody(
  res: Response,
): Promise<{ result?: { tools?: Array<{ name: string }> }; error?: { code: number } }> {
  const text = await res.text();
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream'))
    return JSON.parse(text);
  const data = text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .at(-1);
  return JSON.parse(data!.slice(6));
}

function client(mode: 'legacy' | 'auto', fetchFn?: typeof fetch) {
  const c = new Client({ name: 'app-test', version: '0.0.0' }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer good' } },
    ...(fetchFn ? { fetch: fetchFn } : {}),
  });
  return { c, transport };
}

describe('buildGatewayApp', () => {
  it('answers 401 without a valid key and still names the replica', async () => {
    for (const authorization of ['Bearer bad', undefined]) {
      const res = await post(listBody, { authorization });
      expect(res.status).toBe(401);
      expect(res.headers.get('x-gateway-replica')).toBe('gw-test-0');
    }
  });

  it('answers 403 for a foreign Origin and accepts the app origin', async () => {
    const bad = await post(listBody, { origin: 'http://evil.example' });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('x-gateway-replica')).toBe('gw-test-0');
    expect((await post(listBody, { origin: 'http://app.example.test' })).status).toBe(200);
  });

  it('serves a stateless 2025 tools/list with the replica and buffering headers', async () => {
    const res = await post(listBody);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-replica')).toBe('gw-test-0');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect((await rpcBody(res)).result?.tools?.map((t) => t.name)).toEqual(['fx__get_info']);
  });

  it.each(['legacy', 'auto'] as const)('works with the SDK client in the %s era', async (mode) => {
    const { c, transport } = client(mode);
    await c.connect(transport);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['fx__get_info']);
    await c.close();
  });

  it('marks modern tools/list results cacheable for 30 s per user', async () => {
    const bodies: string[] = [];
    const { c, transport } = client('auto', async (u, init) => {
      const r = await fetch(u, init);
      bodies.push(await r.clone().text());
      return r;
    });
    await c.connect(transport);
    await c.listTools(undefined, { cacheMode: 'bypass' });
    await c.close();
    const list = bodies.find((b) => b.includes('fx__get_info'));
    expect(list).toContain('"ttlMs":30000');
    expect(list).toContain('"cacheScope":"private"');
  });

  it('rejects a modern request whose Mcp-Method header disagrees with the body', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const { c, transport } = client('auto', async (u, init) => {
      seen.push({ url: String(u), init: init ?? {} });
      return fetch(u, init);
    });
    await c.connect(transport);
    await c.listTools(undefined, { cacheMode: 'bypass' });
    await c.close();
    const list = seen.find(
      (s) => typeof s.init.body === 'string' && s.init.body.includes('"tools/list"'),
    );
    expect(list).toBeDefined();
    const headers = new Headers(list!.init.headers);
    expect(headers.get('mcp-method')).toBe('tools/list');
    headers.set('mcp-method', 'tools/call');
    const res = await fetch(list!.url, { method: 'POST', headers, body: list!.init.body });
    expect((await rpcBody(res)).error?.code).toBe(-32020);
  });

  it('returns the SDK parse error for a body that is not JSON', async () => {
    const res = await post('{oops');
    expect(res.status).toBe(400);
    expect((await rpcBody(res)).error?.code).toBe(-32700);
  });

  it('answers 415 for a non-JSON content type', async () => {
    expect((await post(listBody, { 'content-type': 'text/plain' })).status).toBe(415);
  });

  it('answers 405 to GET in stateless mode', async () => {
    const res = await fetch(`${base}/mcp`, { headers: { authorization: 'Bearer good' } });
    expect(res.status).toBe(405);
    expect(res.headers.get('x-gateway-replica')).toBe('gw-test-0');
  });

  it('answers 503 when authentication itself fails', async () => {
    const { a, url } = await start(async () => {
      throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' });
    });
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: listBody,
    });
    expect(res.status).toBe(503);
    await a.close();
  });

  describe('toolMode query', () => {
    async function withSeen(authenticate?: Parameters<typeof start>[0]) {
      const seen: string[] = [];
      const { a, url } = await start(authenticate, (o) => {
        seen.push(o.toolMode);
        return createGatewayServer(o);
      });
      const send = (query: string, headers: Record<string, string> = {}) =>
        fetch(`${url}/mcp${query}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer good',
            'mcp-protocol-version': '2025-11-25',
            ...headers,
          },
          body: listBody,
        });
      return { a, seen, send };
    }

    it('answers 400 for a bad value and never reaches the server factory', async () => {
      const { a, seen, send } = await withSeen();
      for (const q of [
        '?toolMode=bogus',
        '?toolMode=auto',
        '?toolMode=',
        '?toolMode=full&toolMode=search',
      ]) {
        const res = await send(q);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          jsonrpc: '2.0',
          error: { code: -32602, message: 'Invalid toolMode' },
          id: null,
        });
      }
      expect(seen).toEqual([]);
      await a.close();
    });

    it('hands the override to the server factory', async () => {
      const { a, seen, send } = await withSeen();
      expect((await send('?toolMode=search')).status).toBe(200);
      expect((await send('?toolMode=full')).status).toBe(200);
      expect(seen).toEqual(['search', 'full']);
      await a.close();
    });

    it("uses the principal's mode without a query", async () => {
      const { a, seen, send } = await withSeen(async (h) =>
        h === 'Bearer good' ? { ...principal, toolMode: 'search' } : null,
      );
      expect((await send('')).status).toBe(200);
      expect((await send('?other=1')).status).toBe(200);
      expect(seen).toEqual(['search', 'search']);
      await a.close();
    });

    it('answers 401 before it looks at the mode', async () => {
      const { a, seen, send } = await withSeen();
      const res = await send('?toolMode=bogus', { authorization: 'Bearer bad' });
      expect(res.status).toBe(401);
      expect(seen).toEqual([]);
      await a.close();
    });
  });
});

describe('request ids and trace headers', () => {
  const TRACE_H = '0af7651916cd43dd8448eb211c80319c';
  const TRACE_M = '4bf92f3577b34da6a3ce929d0e0e4736';
  const seen: Array<string | undefined> = [];
  const audited: string[] = [];
  let traced: FastifyInstance;
  let url: string;

  beforeAll(async () => {
    const recording: Router = {
      list: () => [],
      resolve: (n) =>
        n === 'fx__get_info'
          ? {
              toolName: 'get_info',
              upstream: {
                record: {
                  id: 'id-fx',
                  slug: 'fx',
                  name: 'fx',
                  url: 'http://x.test/mcp',
                  kind: 'system',
                  enabled: true,
                  approval: 'approved',
                  timeoutMs: 15_000,
                  protocolMode: 'auto',
                  auth: { type: 'none' },
                },
                call: async (_n, _a, _s, tp) => {
                  seen.push(tp);
                  return { outcome: 'ok', result: { content: [{ type: 'text', text: 'hi' }] } };
                },
              },
            }
          : undefined,
    };
    traced = buildGatewayApp({
      router: recording,
      policies: { allows: () => true },
      audit: { write: async (row) => void audited.push(row.requestId) },
      limiter: unlimited,
      authenticate: async () => principal,
      replica: 'gw-test-0',
      allowedOrigins: [],
    });
    await traced.listen({ host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${(traced.server.address() as AddressInfo).port}`;
  });
  afterAll(() => traced.close());

  const callBody = (meta?: Record<string, unknown>) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'fx__get_info', arguments: {}, ...(meta ? { _meta: meta } : {}) },
    });
  const send = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer good',
        'mcp-protocol-version': '2025-11-25',
        ...headers,
      },
      body,
    });

  it('uses the HTTP traceparent header when _meta has none', async () => {
    seen.length = 0;
    await (await send(callBody(), { traceparent: `00-${TRACE_H}-00f067aa0ba902b7-01` })).text();
    expect(seen[0]).toMatch(new RegExp(`^00-${TRACE_H}-[0-9a-f]{16}-01$`));
  });

  it('lets _meta win over the header', async () => {
    seen.length = 0;
    await (
      await send(callBody({ traceparent: `00-${TRACE_M}-00f067aa0ba902b7-01` }), {
        traceparent: `00-${TRACE_H}-00f067aa0ba902b7-01`,
      })
    ).text();
    expect(seen[0]).toMatch(new RegExp(`^00-${TRACE_M}-`));
  });

  it('starts a new trace for an invalid value', async () => {
    seen.length = 0;
    await (await send(callBody(), { traceparent: 'not-a-trace' })).text();
    expect(seen[0]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(seen[0]).not.toContain('not-a-trace');
  });

  it('answers x-request-id, equal to the audit request_id, and ignores the client value', async () => {
    audited.length = 0;
    const res = await send(callBody(), { 'x-request-id': 'chosen-by-client', 'request-id': 'x' });
    await res.text();
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(audited).toEqual([id]);
    const other = await send(callBody());
    await other.text();
    expect(other.headers.get('x-request-id')).not.toBe(id);
  });

  it('sets x-request-id on a refused request too', async () => {
    const res = await send(callBody(), { origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
