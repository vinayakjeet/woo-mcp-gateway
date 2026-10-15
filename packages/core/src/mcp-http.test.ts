import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { checkBearer, logToolCalls, startMcpHttpServer } from './mcp-http.js';

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

  it('shutdown stops accepting but lets an in-flight request finish', async () => {
    const s = await startMcpHttpServer({
      port: 0,
      token: 't0ken',
      ready: () => new Promise((r) => setTimeout(() => r(true), 300)),
      createServer: () => new McpServer({ name: 't', version: '0.0.0' }),
    });
    close = s.close;
    const inFlight = fetch(`${s.url}/readyz`);
    await new Promise((r) => setTimeout(r, 50));

    const done = s.shutdown();

    expect((await inFlight).status).toBe(200);
    await done;
    await expect(fetch(`${s.url}/healthz`)).rejects.toThrow();
  });
});

describe('tool call log', () => {
  let close = async () => {};
  afterEach(() => close());
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

  async function call(meta: Record<string, unknown> | undefined, args: Record<string, unknown>) {
    const lines: Array<Record<string, unknown>> = [];
    const s = await startMcpHttpServer({
      port: 0,
      token: 't0ken',
      ready: async () => true,
      createServer: () => {
        const server = logToolCalls(new McpServer({ name: 't', version: '0.0.0' }), (line) =>
          lines.push(line),
        );
        server.registerTool(
          'ping',
          { description: 'ping', inputSchema: z.object({ secret: z.string().optional() }) },
          async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }),
        );
        server.registerTool(
          'boom',
          { description: 'boom', inputSchema: z.object({}) },
          async () => {
            throw new Error('exploded with secret-in-message');
          },
        );
        return server;
      },
    });
    close = s.close;
    const res = await fetch(`${s.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer t0ken',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: args.name ?? 'ping',
          arguments: args.arguments ?? {},
          ...(meta ? { _meta: meta } : {}),
        },
      }),
    });
    await res.text();
    return lines;
  }

  it('logs the tool and the trace id of a tools/call', async () => {
    const lines = await call({ traceparent: `00-${TRACE}-00f067aa0ba902b7-01` }, {});
    expect(lines).toEqual([
      expect.objectContaining({ level: 'info', msg: 'tool call', tool: 'ping', trace_id: TRACE }),
    ]);
    expect(lines[0]?.ms).toEqual(expect.any(Number));
  });

  it('logs a null trace id when the call carries none or an invalid one', async () => {
    expect((await call(undefined, {}))[0]).toMatchObject({ tool: 'ping', trace_id: null });
    expect((await call({ traceparent: 'garbage' }, {}))[0]).toMatchObject({ trace_id: null });
  });

  it('never logs arguments or error messages', async () => {
    const withArgs = await call(undefined, { arguments: { secret: 'argument-value-42' } });
    expect(JSON.stringify(withArgs)).not.toContain('argument-value-42');
    const failed = await call(undefined, { name: 'boom' });
    expect(JSON.stringify(failed)).not.toContain('secret-in-message');
    expect(failed[0]).toMatchObject({ tool: 'boom' });
  });
});
