import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FetchLike } from '@modelcontextprotocol/client';
import { McpServer, Server } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bulkhead } from './resilience.js';
import { captureLog, fakeUpstream, quietLog, type FakeTool } from './test-helpers.js';
import type { ServerRecord } from './types.js';
import { backoffMs, Upstream, type UpstreamOptions } from './upstream.js';

const SECRET = 'upstream-secret-value';
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const hang: FakeTool = (signal) =>
  new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(new Error('aborted'))),
  );
const cleanup: Array<() => Promise<void>> = [];
const signal = () => new AbortController().signal;

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function record(url: string, over: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id: '00000000-0000-4000-8000-000000000a01',
    slug: 'up',
    name: 'Up',
    url,
    kind: 'external',
    enabled: true,
    approval: 'approved',
    timeoutMs: 15_000,
    protocolMode: 'legacy',
    auth: { type: 'bearer', secret: SECRET },
    ...over,
  };
}

const bearerOk = (req: http.IncomingMessage) => req.headers.authorization === `Bearer ${SECRET}`;

async function upstreamFor(
  tools: Map<string, FakeTool>,
  over: Partial<ServerRecord> = {},
  opts: Partial<UpstreamOptions> = {},
  accept = bearerOk,
) {
  const fake = await fakeUpstream({ tools, accept });
  cleanup.push(() => fake.close());
  const u = new Upstream(record(fake.url, over), {
    log: quietLog,
    healthIntervalMs: 50,
    healthTimeoutMs: 500,
    backoffMinMs: 20,
    backoffMaxMs: 100,
    ...opts,
  });
  cleanup.push(() => u.stop());
  u.start();
  return { u, fake };
}

const connected = (u: Upstream) =>
  vi.waitFor(() => expect(u.state).toBe('connected'), { timeout: 3000, interval: 10 });

describe('Upstream', () => {
  it('connects with a bearer credential and keeps the tools sorted', async () => {
    const onTools = vi.fn();
    const tools = new Map<string, FakeTool>([
      ['zeta', async () => text('z')],
      ['alpha', async () => text('a')],
    ]);
    const { u } = await upstreamFor(tools, {}, { onTools });
    await connected(u);
    expect(u.tools().map((t) => t.name)).toEqual(['alpha', 'zeta']);
    expect(u.status()).toMatchObject({ state: 'connected', toolCount: 2, lastError: null });
    await sleep(200);
    expect(onTools).toHaveBeenCalledTimes(1);
  });

  it('sends only its stored credential, under the configured header name', async () => {
    const seen: Array<{ key: unknown; auth: unknown }> = [];
    const { u } = await upstreamFor(
      new Map([['a', async () => text('a')]]),
      { auth: { type: 'header', headerName: 'X-Api-Key', secret: SECRET } },
      {},
      (req) => {
        seen.push({ key: req.headers['x-api-key'], auth: req.headers.authorization });
        return req.headers['x-api-key'] === SECRET;
      },
    );
    await connected(u);
    expect((await u.call('a', {}, signal())).outcome).toBe('ok');
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((x) => x.key === SECRET && x.auth === undefined)).toBe(true);
  });

  it('classifies a malformed url and keeps retrying instead of rejecting unhandled', async () => {
    const u = new Upstream(record('not a url'), {
      log: quietLog,
      healthIntervalMs: 50,
      healthTimeoutMs: 500,
      backoffMinMs: 10,
      backoffMaxMs: 20,
    });
    cleanup.push(() => u.stop());
    u.start();
    await vi.waitFor(() => expect(u.state).toBe('unreachable'), { timeout: 3000, interval: 10 });
    expect(u.status().lastError).toMatchObject({ kind: 'unknown' });
  });

  it('never follows a redirect, so the credential stays with the configured host', async () => {
    const hits: Array<string | string[] | undefined> = [];
    const target = await fakeUpstream({
      tools: new Map([['a', async () => text('a')]]),
      onRequest: (req) => hits.push(req.headers['x-api-key']),
    });
    cleanup.push(() => target.close());
    const redirector = http.createServer((_req, res) => {
      res.writeHead(307, { location: target.url, connection: 'close' }).end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    cleanup.push(async () => {
      redirector.closeAllConnections();
      await new Promise((r) => redirector.close(r));
    });
    const port = (redirector.address() as AddressInfo).port;
    const u = new Upstream(
      record(`http://127.0.0.1:${port}/mcp`, {
        auth: { type: 'header', headerName: 'X-Api-Key', secret: SECRET },
      }),
      {
        log: quietLog,
        healthIntervalMs: 50,
        healthTimeoutMs: 500,
        backoffMinMs: 10,
        backoffMaxMs: 20,
      },
    );
    cleanup.push(() => u.stop());
    u.start();
    await vi.waitFor(() => expect(u.state).toBe('unreachable'), { timeout: 3000, interval: 10 });
    expect(hits).toEqual([]);
  });

  it('sends an external upstream through the pinned fetch and a managed one through the default', async () => {
    const spy = () => {
      const used: string[] = [];
      const externalFetch: FetchLike = (url, init) => {
        used.push(String(url));
        return fetch(url, init);
      };
      return { used, externalFetch };
    };
    const tools = new Map([['t', async () => text('ok')]]);
    const ext = spy();
    const external = await upstreamFor(tools, { kind: 'external' }, ext);
    await vi.waitFor(() => expect(external.u.state).toBe('connected'));
    expect(ext.used.length).toBeGreaterThan(0);
    const own = spy();
    const managed = await upstreamFor(tools, { kind: 'system', slug: 'sys' }, own);
    await vi.waitFor(() => expect(managed.u.state).toBe('connected'));
    expect(own.used).toEqual([]);
  });

  it('reports a blocked address as its own failure kind', async () => {
    const externalFetch: FetchLike = () =>
      Promise.reject(Object.assign(new Error('x'), { code: 'ERR_UPSTREAM_BLOCKED' }));
    const { u } = await upstreamFor(new Map(), {}, { externalFetch });
    await vi.waitFor(() =>
      expect(u.status().lastError).toEqual({ kind: 'blocked', message: 'address not allowed' }),
    );
  });

  it('does not follow a redirect to the same origin either', async () => {
    const paths: string[] = [];
    const server = http.createServer((req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(307, { location: '/moved', connection: 'close' }).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    const port = (server.address() as AddressInfo).port;
    const u = new Upstream(record(`http://127.0.0.1:${port}/mcp`), {
      log: quietLog,
      healthIntervalMs: 50,
      healthTimeoutMs: 500,
      backoffMinMs: 10,
      backoffMaxMs: 20,
    });
    cleanup.push(() => u.stop());
    u.start();
    await vi.waitFor(() => expect(u.state).toBe('unreachable'), { timeout: 3000, interval: 10 });
    expect(paths.every((x) => x === '/mcp')).toBe(true);
  });

  it('turns unreachable after three failed attempts and never logs the credential', async () => {
    const log = captureLog();
    const onStatus = vi.fn();
    const { u } = await upstreamFor(
      new Map([['a', async () => text('a')]]),
      { auth: { type: 'bearer', secret: 'wrong-secret-value' } },
      { log, onStatus },
    );
    await vi.waitFor(() => expect(u.state).toBe('unreachable'), { timeout: 3000, interval: 10 });
    expect(u.status().lastError).toEqual({ kind: 'http_401', message: 'HTTP 401' });
    expect(onStatus.mock.calls.filter(([, changed]) => changed)).toHaveLength(1);
    expect(log.lines.join('\n')).not.toContain('wrong-secret-value');
    expect(log.lines.join('\n')).toContain('"kind":"http_401"');
  });

  it('passes results through unchanged and marks upstream errors as tool_error', async () => {
    const { u } = await upstreamFor(
      new Map<string, FakeTool>([
        [
          'good',
          async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { n: 1 } }),
        ],
        ['bad', async () => ({ content: [{ type: 'text', text: 'nope' }], isError: true })],
      ]),
    );
    await connected(u);
    const good = await u.call('good', {}, signal());
    expect(good).toMatchObject({
      outcome: 'ok',
      result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { n: 1 } },
    });
    const bad = await u.call('bad', {}, signal());
    expect(bad).toMatchObject({ outcome: 'tool_error', result: { isError: true } });
  });

  it.each(['legacy', 'auto'] as const)(
    'sends a traceparent as _meta and nothing else in protocol_mode %s',
    async (protocolMode) => {
      const metas: unknown[] = [];
      const fake = await fakeUpstream({
        tools: new Map(),
        createServer: () => {
          const s = new McpServer({ name: 'fake', version: '0.0.0' });
          s.registerTool(
            'echo',
            { description: 'echo', inputSchema: z.object({}) },
            async (_a, ctx) => {
              metas.push(ctx.mcpReq._meta);
              return text('ok');
            },
          );
          return s;
        },
      });
      cleanup.push(() => fake.close());
      const u = new Upstream(record(fake.url, { protocolMode, auth: { type: 'none' } }), {
        log: quietLog,
        healthIntervalMs: 50,
        healthTimeoutMs: 500,
        backoffMinMs: 20,
        backoffMaxMs: 100,
      });
      cleanup.push(() => u.stop());
      u.start();
      await connected(u);
      const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-1122334455667788-01';
      expect(await u.call('echo', {}, signal(), tp)).toMatchObject({ outcome: 'ok' });
      expect(await u.call('echo', {}, signal())).toMatchObject({ outcome: 'ok' });
      expect(metas[0]).toMatchObject({ traceparent: tp });
      expect(Object.keys(metas[0] as object)).toEqual(['traceparent']);
      expect(metas[1] ?? {}).not.toHaveProperty('traceparent');
    },
  );

  // Legacy era: the SDK sends notifications/cancelled in a separate POST, which a stateless upstream
  // cannot match to the running handler. In the 2026 era the aborted request stream is the cancel.
  it.each([
    ['legacy', false],
    ['auto', true],
  ] as const)(
    'with protocol_mode %s, times out at the configured limit and upstream handler abort is %s',
    async (protocolMode, handlerAborts) => {
      let aborted = false;
      const tools = new Map<string, FakeTool>([
        [
          'hang',
          (s) =>
            new Promise((_resolve, reject) =>
              s.addEventListener('abort', () => {
                aborted = true;
                reject(new Error('aborted'));
              }),
            ),
        ],
      ]);
      const { u } = await upstreamFor(tools, { timeoutMs: 200, protocolMode });
      await connected(u);
      const t0 = performance.now();
      expect(await u.call('hang', {}, signal())).toEqual({
        outcome: 'timeout',
        message: 'Server up did not answer within 0.2 s',
      });
      expect(performance.now() - t0).toBeLessThan(700);
      if (handlerAborts) await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 2000 });
      else {
        await sleep(500);
        expect(aborted).toBe(false);
      }
    },
  );

  it('reports a client cancel without counting it against the breaker', async () => {
    const { u } = await upstreamFor(new Map([['hang', hang]]));
    await connected(u);
    for (let i = 0; i < 6; i++) {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 30);
      expect(await u.call('hang', {}, ac.signal)).toEqual({
        outcome: 'upstream_error',
        message: 'cancelled by client',
      });
    }
    expect(u.breaker.isOpen).toBe(false);
  });

  it('answers busy when the bulkhead queue wait runs out, without counting it', async () => {
    const { u } = await upstreamFor(
      new Map([['hang', hang]]),
      {},
      {
        bulkhead: new Bulkhead({ limit: 1, maxWaitMs: 100 }),
      },
    );
    await connected(u);
    const ac = new AbortController();
    const first = u.call('hang', {}, ac.signal);
    expect(await u.call('hang', {}, signal())).toEqual({
      outcome: 'timeout',
      message: 'Server up is busy',
    });
    expect(u.breaker.isOpen).toBe(false);
    ac.abort();
    await first;
  });

  it('opens the breaker after five timeouts and then fails fast', async () => {
    const { u } = await upstreamFor(new Map([['hang', hang]]), { timeoutMs: 50 });
    await connected(u);
    for (let i = 0; i < 5; i++)
      expect((await u.call('hang', {}, signal())).outcome).toBe('timeout');
    const t0 = performance.now();
    expect(await u.call('hang', {}, signal())).toEqual({
      outcome: 'unreachable',
      message: 'Server up is unreachable (timeout: no answer within 0.05 s)',
    });
    expect(performance.now() - t0).toBeLessThan(20);
  });

  it('marks the server unreachable at once when a call is refused', async () => {
    const transitions: string[] = [];
    const { u, fake } = await upstreamFor(
      new Map([['a', async () => text('a')]]),
      {},
      {
        onStatus: (x, changed) => void (changed && transitions.push(x.state)),
        healthIntervalMs: 60_000,
      },
    );
    await connected(u);
    await fake.close();
    expect(await u.call('a', {}, signal())).toEqual({
      outcome: 'upstream_error',
      message: 'Server up failed (refused: connection refused)',
    });
    // No health check ran (60 s interval): the call alone moved the state.
    expect(transitions).toEqual(['connected', 'unreachable']);
    expect(await u.call('a', {}, signal())).toEqual({
      outcome: 'unreachable',
      message: 'Server up is unreachable (refused: connection refused)',
    });
  });

  it('checks health at once after a connection reset and stays connected when it passes', async () => {
    let resetNext = false;
    const transitions: string[] = [];
    const fake = await fakeUpstream({
      tools: new Map([['a', async () => text('a')]]),
      accept: bearerOk,
      reset: () => {
        const r = resetNext;
        resetNext = false;
        return r;
      },
    });
    cleanup.push(() => fake.close());
    const u = new Upstream(record(fake.url), {
      log: quietLog,
      healthIntervalMs: 60_000,
      healthTimeoutMs: 500,
      onStatus: (x, changed) => void (changed && transitions.push(x.state)),
    });
    cleanup.push(() => u.stop());
    u.start();
    await connected(u);
    await sleep(20);
    const before = u.status().lastOkAt!.getTime();
    resetNext = true;
    expect((await u.call('a', {}, signal())).outcome).toBe('upstream_error');
    // The interval is 60 s, so a fresh lastOkAt can only come from the out-of-cycle check.
    await vi.waitFor(() => expect(u.status().lastOkAt!.getTime()).toBeGreaterThan(before), {
      timeout: 2000,
      interval: 10,
    });
    expect(u.state).toBe('connected');
    expect(transitions).toEqual(['connected']);
    expect((await u.call('a', {}, signal())).outcome).toBe('ok');
  });

  it('marks the server unreachable when the check after a reset is refused', async () => {
    let resetNext = false;
    const transitions: string[] = [];
    const fake = await fakeUpstream({
      tools: new Map([['a', async () => text('a')]]),
      accept: bearerOk,
      reset: (_req, ctl) => {
        if (!resetNext) return false;
        resetNext = false;
        ctl.stopListening();
        return true;
      },
    });
    cleanup.push(() => fake.close());
    const u = new Upstream(record(fake.url), {
      log: quietLog,
      healthIntervalMs: 60_000,
      healthTimeoutMs: 500,
      backoffMinMs: 60_000,
      backoffMaxMs: 60_000,
      onStatus: (x, changed) => void (changed && transitions.push(x.state)),
    });
    cleanup.push(() => u.stop());
    u.start();
    await connected(u);
    resetNext = true;
    expect((await u.call('a', {}, signal())).outcome).toBe('upstream_error');
    await vi.waitFor(() => expect(u.state).toBe('unreachable'), { timeout: 2000, interval: 10 });
    expect(u.status().lastError).toEqual({ kind: 'refused', message: 'connection refused' });
    expect(transitions).toEqual(['connected', 'unreachable']);
    expect(await u.call('a', {}, signal())).toEqual({
      outcome: 'unreachable',
      message: 'Server up is unreachable (refused: connection refused)',
    });
  });

  it('reconnects when the upstream comes back on the same port', async () => {
    const tools = new Map([['a', async () => text('a')]]);
    const { u, fake } = await upstreamFor(tools, {}, { healthIntervalMs: 60_000 });
    await connected(u);
    await fake.close();
    await u.call('a', {}, signal());
    expect(u.state).toBe('unreachable');
    const again = await fakeUpstream({ tools, port: fake.port, accept: bearerOk });
    cleanup.push(() => again.close());
    await connected(u);
    expect((await u.call('a', {}, signal())).outcome).toBe('ok');
  });

  it('clears the last error once a check succeeds again', async () => {
    const tools = new Map([['a', async () => text('a')]]);
    const { u, fake } = await upstreamFor(tools, {}, { healthIntervalMs: 60_000 });
    await connected(u);
    await fake.close();
    await u.call('a', {}, signal());
    expect(u.status().lastError).toEqual({ kind: 'refused', message: 'connection refused' });
    const again = await fakeUpstream({ tools, port: fake.port, accept: bearerOk });
    cleanup.push(() => again.close());
    await connected(u);
    expect(u.status().lastError).toBeNull();
  });

  it('picks up a new upstream tool on the next health check', async () => {
    const onTools = vi.fn();
    const tools = new Map<string, FakeTool>([['a', async () => text('a')]]);
    const { u } = await upstreamFor(tools, {}, { onTools });
    await connected(u);
    tools.set('b', async () => text('b'));
    await vi.waitFor(() => expect(u.tools().map((t) => t.name)).toEqual(['a', 'b']), {
      timeout: 2000,
    });
    expect(onTools).toHaveBeenCalledTimes(2);
  });

  it('never starts a client for a credential that cannot be decrypted', async () => {
    const onStatus = vi.fn();
    const log = captureLog();
    const u = new Upstream(
      record('http://127.0.0.1:9/mcp', { credentialError: true, auth: { type: 'none' } }),
      {
        log,
        onStatus,
      },
    );
    u.start();
    expect(u.status()).toMatchObject({
      state: 'unreachable',
      lastError: { kind: 'unknown', message: 'stored credential cannot be decrypted' },
    });
    expect(onStatus).toHaveBeenCalledWith(u, true);
    expect(log.lines.join('\n')).toContain('stored credential cannot be decrypted');
    await u.stop();
  });

  it('follows tools/list pagination', async () => {
    const fake = await fakeUpstream({
      tools: new Map(),
      accept: bearerOk,
      createServer: () => {
        const s = new Server({ name: 'paged', version: '0.0.0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', (req) =>
          req.params?.cursor === 'p2'
            ? { tools: [{ name: 'b', inputSchema: { type: 'object' } }] }
            : { tools: [{ name: 'a', inputSchema: { type: 'object' } }], nextCursor: 'p2' },
        );
        return s;
      },
    });
    cleanup.push(() => fake.close());
    const u = new Upstream(record(fake.url), { log: quietLog, healthIntervalMs: 60_000 });
    cleanup.push(() => u.stop());
    u.start();
    await connected(u);
    expect(u.tools().map((t) => t.name)).toEqual(['a', 'b']);
  });

  it.each([
    ['legacy', false],
    ['auto', true],
  ] as const)(
    'with protocol_mode %s, probing server/discover is %s',
    async (protocolMode, probes) => {
      const methods: string[] = [];
      const fake = await fakeUpstream({
        tools: new Map([['a', async () => text('a')]]),
        accept: bearerOk,
        onRequest: (req) => void methods.push(String(req.headers['mcp-method'] ?? '')),
      });
      cleanup.push(() => fake.close());
      const u = new Upstream(record(fake.url, { protocolMode }), {
        log: quietLog,
        healthIntervalMs: 60_000,
      });
      cleanup.push(() => u.stop());
      u.start();
      await connected(u);
      expect(methods.includes('server/discover')).toBe(probes);
    },
  );

  it('stays disabled and idle for a disabled record', async () => {
    const u = new Upstream(record('http://127.0.0.1:9/mcp', { enabled: false }), { log: quietLog });
    u.start();
    expect(u.state).toBe('disabled');
    expect((await u.call('a', {}, signal())).outcome).toBe('unreachable');
    await u.stop();
  });
});

describe('backoffMs', () => {
  it('doubles from 1 s up to 30 s with half of each step random', () => {
    expect(backoffMs(0, 1000, 30_000, () => 0)).toBe(500);
    expect(backoffMs(0, 1000, 30_000, () => 1)).toBe(1000);
    expect(backoffMs(3, 1000, 30_000, () => 1)).toBe(8000);
    expect(backoffMs(10, 1000, 30_000, () => 0)).toBe(15_000);
    expect(backoffMs(10, 1000, 30_000, () => 1)).toBe(30_000);
  });
});
