import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatewayApp, type GatewayAppOptions } from './app.js';
import { createGatewayServer } from './mcp.js';
import type { Router } from './registry.js';
import type { Principal } from './types.js';

const principal: Principal = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'dev@example.com',
  role: 'admin',
  via: 'api_key',
  apiKeyId: null,
  toolMode: 'full',
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
