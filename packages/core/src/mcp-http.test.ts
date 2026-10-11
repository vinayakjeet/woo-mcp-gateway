import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { checkBearer, startMcpHttpServer } from './mcp-http.js';

describe('checkBearer', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['Bearer', false],
    ['Bearer wrong', false],
    ['bearer t0ken', true],
    ['Bearer t0ken', true],
    ['Bearer t0ken ', false],
    ['Basic t0ken', false],
  ])('%j -> %s', (h, ok) => expect(checkBearer(h, 't0ken')).toBe(ok));
});

describe('startMcpHttpServer', () => {
  let close = async () => {};
  afterEach(() => close());

  async function start(ready: () => Promise<boolean>) {
    const s = await startMcpHttpServer({
      port: 0,
      token: 't0ken',
      ready,
      createServer: () => new McpServer({ name: 't', version: '0.0.0' }),
    });
    close = s.close;
    return s.url;
  }

  it('answers healthz without a token and readyz from the probe', async () => {
    let ok = false;
    const url = await start(async () => ok);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/readyz`)).status).toBe(503);
    ok = true;
    expect((await fetch(`${url}/readyz`)).status).toBe(200);
  });

  it('turns a readyz probe that hangs past 2 s into 503', async () => {
    const url = await start(() => new Promise(() => {}));
    const t = performance.now();
    expect((await fetch(`${url}/readyz`)).status).toBe(503);
    expect(performance.now() - t).toBeLessThan(2500);
  });

  it('rejects /mcp without the right bearer token', async () => {
    const url = await start(async () => true);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    for (const auth of [undefined, 'Bearer nope']) {
      const res = await fetch(`${url}/mcp`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      });
      expect(res.status).toBe(401);
    }
  });

  it('404s other paths', async () => {
    const url = await start(async () => true);
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });
});
