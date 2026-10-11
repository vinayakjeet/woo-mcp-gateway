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
