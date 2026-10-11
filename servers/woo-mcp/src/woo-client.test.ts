import { describe, expect, it, vi } from 'vitest';
import { WooClient, WooError } from './woo-client.js';

type Fetch = typeof globalThis.fetch;

const cfg = {
  baseUrl: 'http://wordpress.store-main.svc.cluster.local',
  signingBaseUrl: 'http://main.shop.127.0.0.1.nip.io',
  consumerKey: 'ck_0123456789abcdef0123456789abcdef01234567',
  consumerSecret: 'cs_fedcba9876543210fedcba9876543210fedcba98',
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('WooClient', () => {
  it('sends signed GETs to the in-cluster URL and reads X-WP-Total', async () => {
    const fetch = vi.fn<Fetch>(async () => json([{ id: 1 }], 200, { 'x-wp-total': '7' }));
    const c = new WooClient({ ...cfg, fetch });
    const r = await c.request('GET', '/wp-json/wc/v3/orders', {
      query: { per_page: 1, search: 'a b', status: undefined },
    });
    expect(r).toEqual({ data: [{ id: 1 }], total: 7 });
    const url = new URL(fetch.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe(
      'http://wordpress.store-main.svc.cluster.local/wp-json/wc/v3/orders',
    );
    expect(url.searchParams.get('search')).toBe('a b');
    expect(url.searchParams.has('status')).toBe(false);
    expect(url.searchParams.get('oauth_signature_method')).toBe('HMAC-SHA256');
    expect(url.searchParams.get('oauth_signature')).toMatch(/=$/);
  });

  it('sends a JSON body on POST, unsigned (WooCommerce reads only $_GET and $_POST)', async () => {
    const fetch = vi.fn<Fetch>(async () => json({ id: 9 }, 201));
    await new WooClient({ ...cfg, fetch }).request('POST', '/wp-json/wc/v3/products', {
      body: { name: 'Mug' },
    });
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"Mug"}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('maps WooCommerce errors to WooError with code, without leaking the signed URL or key', async () => {
    const fetch = vi.fn<Fetch>(async () =>
      json(
        {
          code: 'woocommerce_rest_shop_order_invalid_id',
          message: 'Invalid ID.',
          data: { status: 404 },
        },
        404,
      ),
    );
    const err = await new WooClient({ ...cfg, fetch })
      .request('GET', '/wp-json/wc/v3/orders/999')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WooError);
    expect(err).toMatchObject({
      code: 'woocommerce_rest_shop_order_invalid_id',
      status: 404,
      message: 'Invalid ID.',
    });
    const text = `${String(err)} ${JSON.stringify(err)}`;
    expect(text).not.toContain('ck_');
    expect(text).not.toContain('cs_');
    expect(text).not.toContain('oauth_signature');
  });

  it('maps a non-JSON error page to woo_http_<status>', async () => {
    const fetch = vi.fn<Fetch>(
      async () => new Response('<html>bad gateway</html>', { status: 502 }),
    );
    await expect(
      new WooClient({ ...cfg, fetch }).request('GET', '/wp-json/wc/v3/products'),
    ).rejects.toMatchObject({
      code: 'woo_http_502',
    });
  });

  it('times out with woo_timeout and recovers on the next call', async () => {
    let calls = 0;
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(json([]));
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      );
    });
    const c = new WooClient({ ...cfg, fetch, timeoutMs: 20 });
    await expect(c.request('GET', '/wp-json/wc/v3/products')).rejects.toMatchObject({
      code: 'woo_timeout',
    });
    await expect(c.request('GET', '/wp-json/wc/v3/products')).resolves.toEqual({
      data: [],
      total: undefined,
    });
  });

  it('maps network failures to woo_unreachable', async () => {
    const fetch = vi.fn<Fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      new WooClient({ ...cfg, fetch }).request('GET', '/wp-json/wc/v3/products'),
    ).rejects.toMatchObject({
      code: 'woo_unreachable',
    });
  });

  it('reads the unsigned WP REST index', async () => {
    const fetch = vi.fn<Fetch>(async () =>
      json({
        name: 'Main Store',
        url: 'http://x',
        timezone_string: 'Asia/Kolkata',
        gmt_offset: 5.5,
        routes: {},
      }),
    );
    expect(await new WooClient({ ...cfg, fetch }).index()).toEqual({
      name: 'Main Store',
      url: 'http://x',
      timezone_string: 'Asia/Kolkata',
      gmt_offset: 5.5,
    });
    expect(String(fetch.mock.calls[0]![0])).toBe(
      'http://wordpress.store-main.svc.cluster.local/wp-json/',
    );
  });
});
