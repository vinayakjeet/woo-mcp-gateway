import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGatewayApp } from './app.js';
import { ListenHub } from './listen.js';
import type { Router } from './registry.js';
import { quietLog, unlimited } from './test-helpers.js';
import type { Principal } from './types.js';

const principalFor = (apiKeyId: string): Principal => ({
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'dev@example.com',
  role: 'admin',
  via: 'api_key',
  apiKeyId,
  toolMode: 'full',
  rateLimitPerMin: null,
});
const router: Router = {
  list: () => [{ name: 'fx__get_info', description: '[FX] info', inputSchema: { type: 'object' } }],
  resolve: () => undefined,
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(10);
}

describe('subscriptions/listen', () => {
  // A token is valid while it is in this map. Deleting it is the test's way to revoke or expire it.
  const tokens = new Map<string, Principal>();
  let authFails = false;
  let app: FastifyInstance | undefined;
  let hub: ListenHub;
  let base = '';
  const clients: Client[] = [];

  async function start(o: { maxPerKey?: number; recheckMs?: number; debounceMs?: number } = {}) {
    tokens.clear();
    tokens.set('k1', principalFor('key-1'));
    tokens.set('k1b', principalFor('key-1'));
    tokens.set('k2', principalFor('key-2'));
    authFails = false;
    const authenticate = async (h?: string) => {
      if (authFails) throw new Error('database down');
      return tokens.get(/^Bearer (\S+)$/.exec(h ?? '')?.[1] ?? '') ?? null;
    };
    hub = new ListenHub({ authenticate, log: quietLog, debounceMs: 100, recheckMs: 60_000, ...o });
    app = buildGatewayApp({
      router,
      policies: { allows: () => true },
      audit: { write: async () => {} },
      limiter: unlimited,
      authenticate,
      listen: hub,
      replica: 'gw-test-0',
      allowedOrigins: [],
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }

  async function open(token: string) {
    // The default client connects in the 2025 era, which has no subscriptions/listen.
    const client = new Client(
      { name: 'listen-test', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    clients.push(client);
    let count = 0;
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      count++;
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const sub = await client.listen({ toolsListChanged: true });
    return { client, sub, count: () => count };
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    hub?.close();
    await app?.close();
    app = undefined;
  });

  it('a client with an open listen stream gets tools/list_changed within 1 s of the event', async () => {
    await start();
    const a = await open('k1');
    expect(a.count()).toBe(0);
    hub.toolsChanged();
    await until(() => a.count() > 0, 1000);
    expect(a.count()).toBe(1);
  });

  it('two events within 100 ms give one notification', async () => {
    await start();
    const a = await open('k1');
    hub.toolsChanged();
    await wait(30);
    hub.toolsChanged();
    await wait(400);
    expect(a.count()).toBe(1);
  });

  it('a resync after a lost LISTEN sends one notification to every open stream', async () => {
    await start();
    const a = await open('k1');
    const b = await open('k2');
    hub.resync();
    await until(() => a.count() > 0 && b.count() > 0, 1000);
    await wait(300);
    expect([a.count(), b.count()]).toEqual([1, 1]);
  });

  it('a legacy client is unaffected by events and still lists tools', async () => {
    await start();
    hub.toolsChanged();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer k1',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('fx__get_info');
    const init = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer k1',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy', version: '0' },
        },
      }),
    });
    expect(await init.text()).not.toContain('listChanged');
  });

  it('closes a stream whose key is revoked, within the recheck interval, and frees its slot', async () => {
    await start({ recheckMs: 150 });
    const a = await open('k1');
    const ok = await open('k2');
    tokens.delete('k1');
    expect(await Promise.race([a.sub.closed, wait(2000).then(() => 'still open')])).toMatch(
      /^(remote|graceful)$/,
    );
    // The other key keeps its stream.
    hub.toolsChanged();
    await until(() => ok.count() > 0, 1000);
    expect(ok.count()).toBe(1);
    expect(hub.size).toBe(1);
  });

  it('checks the credential before each send: a revoked stream never gets the event', async () => {
    await start();
    const a = await open('k1');
    const b = await open('k2');
    tokens.delete('k1');
    hub.toolsChanged();
    await until(() => b.count() > 0, 1000);
    await wait(200);
    expect(a.count()).toBe(0);
    expect(b.count()).toBe(1);
    expect(await Promise.race([a.sub.closed, wait(1000).then(() => 'still open')])).toMatch(
      /^(remote|graceful)$/,
    );
  });

  it('keeps a stream open when the credential check itself fails', async () => {
    await start({ recheckMs: 100 });
    const a = await open('k1');
    authFails = true;
    await wait(400);
    authFails = false;
    hub.toolsChanged();
    await until(() => a.count() > 0, 1000);
    expect(a.count()).toBe(1);
  });

  it('allows 3 open streams per key and answers the 4th with 429 until one closes', async () => {
    await start({ maxPerKey: 3 });
    const s1 = await open('k1');
    await open('k1b');
    await open('k1');
    await expect(open('k1b')).rejects.toThrow(/Too many open listen streams/);
    // Another key has its own budget.
    await open('k2');
    await s1.sub.close();
    await until(() => hub.size === 3, 1000);
    await open('k1b');
  });

  it('a 429 for the cap is answered before the stream starts, with Retry-After', async () => {
    await start({ maxPerKey: 1 });
    await open('k1');
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer k1b',
        'mcp-protocol-version': '2026-07-28',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'subscriptions/listen', params: {} }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(hub.size).toBe(1);
  });

  it('requests that are not listen are not counted against the cap', async () => {
    await start({ maxPerKey: 1 });
    await open('k1');
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer k1b',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list', params: {} }),
      });
      expect(res.status).toBe(200);
      await res.text();
    }
  });
});
