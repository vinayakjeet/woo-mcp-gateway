import { McpServer } from '@modelcontextprotocol/server';
import { logToolCalls } from '@woo/core/mcp-http';
import { resolveRange, startOfDay, storeTimeZone, toWcGmt } from './dates.js';
import {
  createdProduct,
  orderDetail,
  orderSummary,
  productSummary,
  statusChange,
} from './mappers.js';
import * as s from './schemas.js';
import { WooError, type WooApi } from './woo-client.js';

type Obj = Record<string, unknown>;
interface StoreContext {
  name: string;
  url: string;
  timeZone: string;
  currency: string;
}

const ok = (summary: string, data: Obj) => ({
  content: [{ type: 'text' as const, text: summary }],
  structuredContent: data,
});
const fail = (code: string, message: string) => ({
  content: [{ type: 'text' as const, text: `${code}: ${message}` }],
  isError: true,
});

function guard<A>(fn: (args: A) => Promise<ReturnType<typeof ok>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof WooError) return fail(e.code, e.message);
      if (e instanceof RangeError) return fail('invalid_arguments', e.message);
      console.error(JSON.stringify({ level: 'error', msg: 'tool failed', error: String(e) }));
      return fail('internal_error', 'woo-mcp failed to handle the call');
    }
  };
}

export function buildWooServer(deps: { woo: WooApi; now?: () => Date }): () => McpServer {
  const { woo } = deps;
  const now = deps.now ?? (() => new Date());
  let store: Promise<StoreContext> | undefined;

  // Read once; a failed read is retried on the next call instead of being cached.
  const context = () => {
    store ??= (async () => {
      const [index, currency] = await Promise.all([
        woo.index(),
        woo.request<{ value: string }>(
          'GET',
          '/wp-json/wc/v3/settings/general/woocommerce_currency',
        ),
      ]);
      return {
        name: index.name,
        url: index.url,
        timeZone: storeTimeZone(index),
        currency: currency.data.value,
      };
    })().catch((e: unknown) => {
      store = undefined;
      throw e;
    });
    return store;
  };

  return () => {
    const server = logToolCalls(new McpServer({ name: 'woo-mcp', version: '0.1.0' }));

    server.registerTool(
      'get_info',
      {
        description:
          'Store name, URL, currency, timezone and the number of orders placed today (store time).',
        inputSchema: s.getInfoInput,
        annotations: { readOnlyHint: true },
      },
      guard(async () => {
        const c = await context();
        const t = now();
        const r = await woo.request<unknown[]>('GET', '/wp-json/wc/v3/orders', {
          query: {
            after: toWcGmt(startOfDay(c.timeZone, t, 0)),
            before: toWcGmt(t),
            dates_are_gmt: true,
            per_page: 1,
          },
        });
        const data = {
          name: c.name,
          url: c.url,
          currency: c.currency,
          timezone: c.timeZone,
          orders_today: r.total ?? 0,
        };
        return ok(
          `${c.name}: ${data.orders_today} orders today (${c.timeZone}, ${c.currency})`,
          data,
        );
      }),
    );

    server.registerTool(
      'list_products',
      {
        description: 'List products, optionally filtered by search text and status.',
        inputSchema: s.listProductsInput,
        annotations: { readOnlyHint: true },
      },
      guard(async (a: { search?: string; status: string; page: number; per_page: number }) => {
        const r = await woo.request<Obj[]>('GET', '/wp-json/wc/v3/products', { query: { ...a } });
        const products = r.data.map(productSummary);
        return ok(`${products.length} of ${r.total ?? products.length} products`, {
          products,
          total: r.total ?? products.length,
          page: a.page,
        });
      }),
    );

    server.registerTool(
      'create_product',
      {
        description: 'Create a simple product. Price is a decimal string in the store currency.',
        inputSchema: s.createProductInput,
        annotations: { destructiveHint: false },
      },
      guard(async (a: { stock_quantity?: number }) => {
        const body = {
          type: 'simple',
          ...a,
          ...(a.stock_quantity !== undefined ? { manage_stock: true } : {}),
        };
        const p = createdProduct(
          (await woo.request<Obj>('POST', '/wp-json/wc/v3/products', { body })).data,
        );
        return ok(`Created product ${String(p.id)} "${String(p.name)}" (${String(p.status)})`, p);
      }),
    );

    server.registerTool(
      'list_orders',
      {
        description:
          'List orders. Use date (today, yesterday, last_7_days; store timezone) or after/before, not both.',
        inputSchema: s.listOrdersInput,
        annotations: { readOnlyHint: true },
      },
      guard(
        async (a: {
          date?: 'today' | 'yesterday' | 'last_7_days';
          after?: string;
          before?: string;
          status?: string;
          page: number;
          per_page: number;
        }) => {
          const c = await context();
          const range = resolveRange(a, c.timeZone, now());
          const r = await woo.request<Obj[]>('GET', '/wp-json/wc/v3/orders', {
            query: {
              after: range.after && toWcGmt(range.after),
              before: range.before && toWcGmt(range.before),
              dates_are_gmt: range.after || range.before ? true : undefined,
              status: a.status === 'any' ? undefined : a.status,
              page: a.page,
              per_page: a.per_page,
            },
          });
          const orders = r.data.map(orderSummary);
          return ok(`${orders.length} of ${r.total ?? orders.length} orders`, {
            orders,
            total: r.total ?? orders.length,
            page: a.page,
            timezone: c.timeZone,
          });
        },
      ),
    );

    server.registerTool(
      'get_order',
      {
        description:
          'One order with totals, payment method, dates, billing first name and city, and line items.',
        inputSchema: s.getOrderInput,
        annotations: { readOnlyHint: true },
      },
      guard(async (a: { order_id: number }) => {
        const o = orderDetail(
          (await woo.request<Obj>('GET', `/wp-json/wc/v3/orders/${a.order_id}`)).data,
        );
        return ok(
          `Order ${a.order_id}: ${String(o.status)}, ${String(o.totals.total)} ${String(o.currency)}`,
          o,
        );
      }),
    );

    server.registerTool(
      'update_order_status',
      {
        description: 'Change an order status, optionally adding a private note.',
        inputSchema: s.updateOrderStatusInput,
        annotations: { destructiveHint: true },
      },
      guard(async (a: { order_id: number; status: string; note?: string }) => {
        const path = `/wp-json/wc/v3/orders/${a.order_id}`;
        const before = await woo.request<Obj>('GET', path);
        const after = await woo.request<Obj>('PUT', path, { body: { status: a.status } });
        if (a.note)
          await woo.request('POST', `${path}/notes`, {
            body: { note: a.note, customer_note: false },
          });
        const r = statusChange(after.data.id, before.data.status, after.data.status);
        return ok(`Order ${a.order_id}: ${String(r.previous_status)} -> ${String(r.status)}`, r);
      }),
    );

    return server;
  };
}
