import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpHttpServer } from '@woo/core/mcp-http';
import { Frankfurter } from './frankfurter.js';
import { buildFxServer } from './tools.js';

const json = (b: unknown) =>
  new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });

describe.each(['legacy', 'auto'] as const)('fx-mcp over HTTP (%s protocol era)', (mode) => {
  let urls: string[];
  let failNext: boolean;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    urls = [];
    failNext = false;
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (failNext) {
        failNext = false;
        throw new TypeError('fetch failed');
      }
      if (url.includes('/currencies'))
        return json({ EUR: 'Euro', USD: 'US Dollar', INR: 'Indian Rupee' });
      return json({ amount: 1, base: 'EUR', date: '2026-10-09', rates: { USD: 1.1206 } });
    };
    const s = await startMcpHttpServer({
      port: 0,
      token: 't0ken',
      ready: async () => true,
      createServer: buildFxServer({ fx: new Frankfurter({ fetch }) }),
    });
    close = s.close;
    client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer t0ken' } },
      }),
    );
  });
  afterEach(async () => {
    await client.close();
    await close();
  });

  it('lists get_info, convert_currency, get_rates as read-only', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['convert_currency', 'get_info', 'get_rates']);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it('converts with the provider rate', async () => {
    const r = await client.callTool({
      name: 'convert_currency',
      arguments: { amount: 100, from: 'EUR', to: 'USD' },
    });
    expect(r.structuredContent).toEqual({
      amount: 100,
      from: 'EUR',
      to: 'USD',
      rate: 1.1206,
      result: 112.06,
      date: '2026-10-09',
      stale: false,
      cache_age_seconds: 0,
    });
  });

  it('same currency returns rate 1 without calling the provider', async () => {
    const r = await client.callTool({
      name: 'convert_currency',
      arguments: { amount: 5, from: 'INR', to: 'INR' },
    });
    expect(r.structuredContent).toMatchObject({ rate: 1, result: 5 });
    expect(urls).toHaveLength(0);
  });

  it.each([
    { amount: 0, from: 'EUR', to: 'USD' },
    { amount: 1, from: 'eur', to: 'USD' },
    { amount: 1, from: 'EUR', to: 'USD', date: '09-10-2026' },
  ])('rejects %j', async (args) => {
    expect((await client.callTool({ name: 'convert_currency', arguments: args })).isError).toBe(
      true,
    );
    expect(urls).toHaveLength(0);
  });

  it('provider failure is a tool error with the fx code', async () => {
    failNext = true;
    const r = await client.callTool({ name: 'get_rates', arguments: { base: 'EUR' } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('fx_unreachable');
  });

  it('get_info reports provider, base currencies and cache age', async () => {
    const r = await client.callTool({ name: 'get_info', arguments: {} });
    expect(r.structuredContent).toMatchObject({
      provider: 'Frankfurter',
      base_currencies: ['EUR', 'INR', 'USD'],
    });
  });
});

describe('fx-mcp answers from cache when Frankfurter goes away', () => {
  let stub: http.Server;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    stub = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          req.url?.startsWith('/v1/currencies')
            ? { EUR: 'Euro', USD: 'US Dollar' }
            : { amount: 1, base: 'EUR', date: '2026-10-09', rates: { USD: 1.1206 } },
        ),
      );
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    const { port } = stub.address() as AddressInfo;
    // TTL 0 makes every call go to the API, so a closed stub means an outage.
    const fx = new Frankfurter({ baseUrl: `http://127.0.0.1:${port}/v1`, ttlMs: 0 });
    const s = await startMcpHttpServer({
      port: 0,
      token: 't0ken',
      ready: async () => true,
      createServer: buildFxServer({ fx }),
    });
    close = s.close;
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer t0ken' } },
      }),
    );
  });
  afterEach(async () => {
    await client.close();
    await close();
    if (stub.listening) await stopStub();
  });

  const stopStub = () =>
    new Promise<void>((r) => {
      stub.close(() => r());
      stub.closeAllConnections();
    });
  const text = (r: Awaited<ReturnType<Client['callTool']>>) =>
    (r.content as { type: string; text: string }[])[0]?.text ?? '';
  const convert = () =>
    client.callTool({
      name: 'convert_currency',
      arguments: { amount: 100, from: 'EUR', to: 'USD' },
    });

  it('fresh answers have stale false', async () => {
    const r = await convert();
    expect(text(r)).toBe('100 EUR = 112.06 USD');
    expect(r.structuredContent).toMatchObject({ stale: false, cache_age_seconds: 0 });
    const g = await client.callTool({ name: 'get_rates', arguments: { base: 'EUR' } });
    expect(g.structuredContent).toMatchObject({ stale: false, cache_age_seconds: 0 });
    const i = await client.callTool({ name: 'get_info', arguments: {} });
    expect(i.structuredContent).toMatchObject({ stale: false });
  });

  it('convert_currency answers from cache after the API goes away', async () => {
    await convert();
    await stopStub();
    const r = await convert();
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe(
      'Cached rates from 2026-10-09, fetched less than a minute ago (Frankfurter is unreachable): 100 EUR = 112.06 USD',
    );
    expect(r.structuredContent).toMatchObject({
      result: 112.06,
      stale: true,
      cache_age_seconds: expect.any(Number),
      date: '2026-10-09',
    });
  });

  it('get_info answers stale', async () => {
    await client.callTool({ name: 'get_info', arguments: {} });
    await stopStub();
    const r = await client.callTool({ name: 'get_info', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(
      /^Cached currency list, fetched .* ago \(Frankfurter is unreachable\): /,
    );
    expect(r.structuredContent).toMatchObject({
      base_currencies: ['EUR', 'USD'],
      stale: true,
      cache_age_seconds: expect.any(Number),
    });
  });

  it('with no cache the tool error is fx_unreachable', async () => {
    await stopStub();
    const r = await convert();
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('fx_unreachable: Frankfurter is unreachable and no cached rates exist');
  });

  it('the convert_currency and get_rates descriptions mention the cached fallback', async () => {
    const { tools } = await client.listTools();
    const sentence =
      'If the rate provider is unreachable, it answers from the last cached rates and says how old they are.';
    for (const name of ['convert_currency', 'get_rates'])
      expect(tools.find((t) => t.name === name)?.description).toContain(sentence);
  });
});
