import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpHttpServer } from '@woo/core/mcp-http';
import { loadConfig } from './config.js';
import { buildWooServer } from './tools.js';
import { WooError, type WooApi } from './woo-client.js';

type Call = { method: string; path: string; query?: Record<string, unknown>; body?: unknown };

function fakeWoo(): WooApi & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    index: async () => ({
      name: 'Main Store',
      url: 'http://main.shop.127.0.0.1.nip.io',
      timezone_string: 'Asia/Kolkata',
      gmt_offset: 5.5,
    }),
    request: async <T>(
      method: string,
      path: string,
      opts: { query?: Record<string, unknown>; body?: unknown } = {},
    ) => {
      calls.push({ method, path, ...opts });
      if (path.endsWith('/settings/general/woocommerce_currency'))
        return { data: { value: 'INR' } as T };
      if (path === '/wp-json/wc/v3/orders' && method === 'GET') return { data: [] as T, total: 3 };
      if (path === '/wp-json/wc/v3/orders/999')
        throw new WooError('woocommerce_rest_shop_order_invalid_id', 'Invalid ID.', 404);
      if (path === '/wp-json/wc/v3/orders/41' && method === 'GET')
        return { data: { id: 41, status: 'processing' } as T };
      if (path === '/wp-json/wc/v3/orders/41' && method === 'PUT')
        return { data: { id: 41, status: 'completed' } as T };
      if (path === '/wp-json/wc/v3/products' && method === 'POST')
        return {
          data: { id: 5, name: 'Mug', price: '199', status: 'publish', permalink: 'p' } as T,
        };
      return { data: [] as T, total: 0 };
    },
  };
}

describe.each(['legacy', 'auto'] as const)('woo-mcp over HTTP (%s protocol era)', (mode) => {
  let woo: ReturnType<typeof fakeWoo>;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    woo = fakeWoo();
    const s = await startMcpHttpServer({
      port: 0,
      token: 't0ken',
      ready: async () => true,
      createServer: buildWooServer({ woo, now: () => new Date('2026-10-11T03:00:00Z') }),
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

  it('lists the six tools with SPEC annotations', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(Object.keys(byName).sort()).toEqual([
      'create_product',
      'get_info',
      'get_order',
      'list_orders',
      'list_products',
      'update_order_status',
    ]);
    expect(byName.list_orders?.readOnlyHint).toBe(true);
    expect(byName.create_product?.destructiveHint).toBe(false);
    expect(byName.update_order_status?.destructiveHint).toBe(true);
  });

  it('get_info returns store context and orders today', async () => {
    const r = await client.callTool({ name: 'get_info', arguments: {} });
    expect(r.structuredContent).toEqual({
      name: 'Main Store',
      url: 'http://main.shop.127.0.0.1.nip.io',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      orders_today: 3,
    });
    expect(woo.calls.find((c) => c.path === '/wp-json/wc/v3/orders')?.query).toMatchObject({
      after: '2026-10-10T18:30:00',
      dates_are_gmt: true,
      per_page: 1,
    });
  });

  it('list_orders resolves today in store time and sends GMT bounds', async () => {
    await client.callTool({ name: 'list_orders', arguments: { date: 'today', status: 'any' } });
    const q = woo.calls.find((c) => c.path === '/wp-json/wc/v3/orders')?.query;
    expect(q).toMatchObject({
      after: '2026-10-10T18:30:00',
      before: '2026-10-11T03:00:00',
      dates_are_gmt: true,
      page: 1,
      per_page: 20,
    });
    expect(q?.status).toBeUndefined();
  });

  it('list_orders with date and after is a tool error', async () => {
    const r = await client.callTool({
      name: 'list_orders',
      arguments: { date: 'today', after: '2026-10-01T00:00:00Z' },
    });
    expect(r.isError).toBe(true);
  });

  it('get_order on an unknown id is a tool error with the WooCommerce code', async () => {
    const r = await client.callTool({ name: 'get_order', arguments: { order_id: 999 } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('woocommerce_rest_shop_order_invalid_id');
  });

  it('update_order_status reports the previous status and adds the note', async () => {
    const r = await client.callTool({
      name: 'update_order_status',
      arguments: { order_id: 41, status: 'completed', note: 'packed' },
    });
    expect(r.structuredContent).toEqual({
      id: 41,
      previous_status: 'processing',
      status: 'completed',
    });
    expect(
      woo.calls.some((c) => c.method === 'POST' && c.path === '/wp-json/wc/v3/orders/41/notes'),
    ).toBe(true);
  });

  it('create_product sets manage_stock when stock_quantity is given', async () => {
    await client.callTool({
      name: 'create_product',
      arguments: { name: 'Mug', regular_price: '199', stock_quantity: 4 },
    });
    expect(woo.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      name: 'Mug',
      regular_price: '199',
      manage_stock: true,
      stock_quantity: 4,
      status: 'publish',
    });
  });

  it('invalid arguments are rejected by the SDK before the handler runs', async () => {
    const r = await client.callTool({ name: 'list_products', arguments: { per_page: 99 } });
    expect(r.isError).toBe(true);
    expect(woo.calls).toHaveLength(0);
  });
});

describe('loadConfig', () => {
  it('names missing vars and never echoes values', () => {
    expect(() => loadConfig({ MCP_SHARED_TOKEN: 'sekret' })).toThrow(
      /WC_BASE_URL.*WC_CONSUMER_SECRET/,
    );
    expect(() => loadConfig({ MCP_SHARED_TOKEN: 'sekret' })).not.toThrow(/sekret/);
  });
});
