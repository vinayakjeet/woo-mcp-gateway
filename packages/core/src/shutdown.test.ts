import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { drainServers, installGracefulShutdown } from './shutdown.js';

const open: http.Server[] = [];
const agents: http.Agent[] = [];

afterEach(() => {
  for (const a of agents.splice(0)) a.destroy();
  for (const s of open.splice(0)) s.closeAllConnections();
});

async function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  open.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  ports.set(server, (server.address() as AddressInfo).port);
  return server;
}

const ports = new WeakMap<http.Server, number>();
const closeOf = (s: http.Server) => () => new Promise<void>((r) => s.close(() => r()));

function keepAliveAgent(): http.Agent {
  const a = new http.Agent({ keepAlive: true });
  agents.push(a);
  return a;
}

function get(server: http.Server, agent: http.Agent): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: ports.get(server), agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      })
      .on('error', reject);
  });
}

describe('drainServers', () => {
  it('closes an idle keep-alive socket without waiting for the grace period', async () => {
    const server = await listen((_req, res) => res.end('ok'));
    const agent = keepAliveAgent();
    expect(await get(server, agent)).toBe(200);

    const t = performance.now();
    await drainServers({ servers: [server], close: closeOf(server), graceMs: 5000 });

    expect(performance.now() - t).toBeLessThan(1000);
    await expect(get(server, keepAliveAgent())).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('lets an in-flight request finish inside the grace period', async () => {
    const server = await listen((_req, res) => setTimeout(() => res.end('late'), 300));
    const pending = get(server, keepAliveAgent());
    await new Promise((r) => setTimeout(r, 50));

    const t = performance.now();
    await drainServers({ servers: [server], close: closeOf(server), graceMs: 5000 });

    expect(await pending).toBe(200);
    expect(performance.now() - t).toBeGreaterThanOrEqual(200);
    expect(performance.now() - t).toBeLessThan(2000);
  });

  it('gives up on a request that outlasts the grace period', async () => {
    const server = await listen(() => {});
    const pending = get(server, keepAliveAgent()).catch((e: NodeJS.ErrnoException) => e.code);
    await new Promise((r) => setTimeout(r, 50));

    const t = performance.now();
    await drainServers({ servers: [server], close: closeOf(server), graceMs: 300 });

    expect(performance.now() - t).toBeGreaterThanOrEqual(250);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(await pending).toBe('ECONNRESET');
  });

  it('stops waiting at the grace period when close itself hangs', async () => {
    const server = await listen((_req, res) => res.end('ok'));
    const t = performance.now();
    await drainServers({ servers: [server], close: () => new Promise(() => {}), graceMs: 300 });
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe('installGracefulShutdown', () => {
  function setup(close: () => Promise<void>) {
    const proc = new EventEmitter();
    const codes: number[] = [];
    let calls = 0;
    installGracefulShutdown({
      servers: [],
      close: async () => {
        calls++;
        await close();
      },
      graceMs: 200,
      proc,
      exit: (code: number) => codes.push(code),
    });
    return { proc, codes, calls: () => calls };
  }

  const settled = () => new Promise((r) => setTimeout(r, 50));

  it.each(['SIGTERM', 'SIGINT'])('exits 0 on %s', async (sig) => {
    const { proc, codes } = setup(async () => {});
    proc.emit(sig);
    await settled();
    expect(codes).toEqual([0]);
  });

  it('runs close once when a second signal arrives', async () => {
    const { proc, codes, calls } = setup(() => new Promise((r) => setTimeout(r, 100)));
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 250));
    expect(calls()).toBe(1);
    expect(codes).toEqual([0]);
  });

  it('exits 0 after the grace period when close never finishes', async () => {
    const { proc, codes } = setup(() => new Promise(() => {}));
    proc.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    expect(codes).toEqual([0]);
  });

  it('exits 1 when close fails', async () => {
    const { proc, codes } = setup(() => Promise.reject(new Error('boom')));
    proc.emit('SIGTERM');
    await settled();
    expect(codes).toEqual([1]);
  });
});
