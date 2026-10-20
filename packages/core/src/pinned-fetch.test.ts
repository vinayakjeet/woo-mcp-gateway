import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOCKED_CODE, checkedLookup, pinnedFetch } from './pinned-fetch.js';
import { parseDenyAddresses } from './ssrf.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function server(handler: http.RequestListener) {
  let connections = 0;
  const s = http.createServer(handler);
  s.on('connection', () => (connections += 1));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        s.close(() => r());
        s.closeAllConnections();
      }),
  );
  return { port: (s.address() as AddressInfo).port, connections: () => connections };
}

const toLocal = async () => ['127.0.0.1'];

// The gateway classifies an error by the codes along its cause chain, and so does this.
function isBlocked(err: unknown): boolean {
  for (let cur = err, i = 0; cur && i < 6; i++, cur = (cur as { cause?: unknown }).cause)
    if ((cur as { code?: unknown }).code === BLOCKED_CODE) return true;
  return false;
}

describe('pinnedFetch', () => {
  it('refuses to connect when the name resolves to 127.0.0.1, and opens no socket', async () => {
    const srv = await server((_req, res) => res.end('secret'));
    const f = pinnedFetch({ allowInsecure: true, resolve: toLocal });
    const err = await f(`http://api.example.com:${srv.port}/`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isBlocked(err)).toBe(true);
    expect(srv.connections()).toBe(0);
  });

  it('refuses an IP literal that is private, which never reaches the lookup', async () => {
    const srv = await server((_req, res) => res.end('secret'));
    const f = pinnedFetch({ allowInsecure: true });
    const err = await f(`http://127.0.0.1:${srv.port}/`).catch((e: unknown) => e);
    expect(isBlocked(err)).toBe(true);
    expect(srv.connections()).toBe(0);
  });

  it('connects to the address it checked', async () => {
    const srv = await server((_req, res) => res.end('hello'));
    const f = pinnedFetch({
      allowInsecure: true,
      resolve: toLocal,
      // Test only: the real check rejects loopback.
      isAllowed: (ip) => ip === '127.0.0.1',
    });
    const r = await f(`http://api.example.com:${srv.port}/`);
    expect(await r.text()).toBe('hello');
    expect(srv.connections()).toBe(1);
  });

  it('treats a 3xx as an error and never fetches the Location', async () => {
    const target = await server((_req, res) => res.end('internal'));
    const srv = await server((_req, res) =>
      res.writeHead(302, { location: `http://127.0.0.1:${target.port}/` }).end(),
    );
    const f = pinnedFetch({
      allowInsecure: true,
      resolve: toLocal,
      isAllowed: (ip) => ip === '127.0.0.1',
    });
    await expect(f(`http://api.example.com:${srv.port}/`)).rejects.toThrow();
    expect(target.connections()).toBe(0);
  });

  it('refuses http unless allowInsecure is set', async () => {
    const srv = await server((_req, res) => res.end('x'));
    const f = pinnedFetch({ allowInsecure: false, resolve: toLocal, isAllowed: () => true });
    await expect(f(`http://api.example.com:${srv.port}/`)).rejects.toThrow();
    expect(srv.connections()).toBe(0);
  });

  it('refuses cluster names before any lookup', async () => {
    let looked = 0;
    const f = pinnedFetch({
      allowInsecure: true,
      resolve: async () => {
        looked += 1;
        return ['140.82.112.3'];
      },
    });
    for (const u of [
      'http://fx-mcp.platform.svc.cluster.local:8080/mcp',
      'http://169.254.169.254/latest',
      'http://metadata.google.internal/',
    ]) {
      expect(isBlocked(await f(u).catch((e: unknown) => e)), u).toBe(true);
    }
    expect(looked).toBe(0);
  });
});

describe('checkedLookup', () => {
  const run = (
    lookup: ReturnType<typeof checkedLookup>,
    all: boolean,
  ): Promise<{ err: NodeJS.ErrnoException | null; out: unknown }> =>
    new Promise((resolve) =>
      lookup('api.example.com', { all }, (err: NodeJS.ErrnoException | null, ...out: unknown[]) =>
        resolve({ err, out: all ? out[0] : out }),
      ),
    );

  it('answers in both shapes Node asks for', async () => {
    const lookup = checkedLookup({ resolve: async () => ['140.82.112.3'] });
    expect((await run(lookup, true)).out).toEqual([{ address: '140.82.112.3', family: 4 }]);
    expect((await run(lookup, false)).out).toEqual(['140.82.112.3', 4]);
  });

  it('rebinding: a name that was public at the first lookup and private at connect time is refused', async () => {
    const answers = [['140.82.112.3'], ['10.0.0.7']];
    const lookup = checkedLookup({ resolve: async () => answers.shift()! });
    expect((await run(lookup, true)).err).toBeNull();
    const second = await run(lookup, true);
    expect(second.err?.code).toBe(BLOCKED_CODE);
  });

  it('refuses when any answer is private', async () => {
    const lookup = checkedLookup({ resolve: async () => ['140.82.112.3', '10.0.0.7'] });
    expect((await run(lookup, true)).err?.code).toBe(BLOCKED_CODE);
  });

  it('refuses a denied public address at connect time, also when the name was fine at the check', async () => {
    const deny = parseDenyAddresses('20.193.153.146/32');
    const answers = [['140.82.112.3'], ['20.193.153.146']];
    const lookup = checkedLookup({ resolve: async () => answers.shift()!, deny });
    expect((await run(lookup, true)).err).toBeNull();
    expect((await run(lookup, true)).err?.code).toBe(BLOCKED_CODE);
  });

  it('passes a failed resolution on as a DNS error', async () => {
    const lookup = checkedLookup({
      resolve: async () => {
        throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
      },
    });
    expect((await run(lookup, true)).err?.code).toBe('ENOTFOUND');
  });
});
