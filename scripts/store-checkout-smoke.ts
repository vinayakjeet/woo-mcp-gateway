// Guest checkout through the WooCommerce Store API: add one product, pay with Cash on delivery.
// The Store API needs the session cookie and the Nonce header from an earlier response.
const base = (process.argv[2] ?? 'http://main.shop.127.0.0.1.nip.io').replace(/\/$/, '');
const api = `${base}/wp-json/wc/store/v1`;

let cookies: string[] = [];
let nonce = '';

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (cookies.length > 0) headers.set('Cookie', cookies.join('; '));
  if (nonce) headers.set('Nonce', nonce);
  const res = await fetch(`${api}${path}`, { ...init, headers });
  const setCookies = res.headers.getSetCookie().map((c) => c.split(';')[0] ?? '');
  if (setCookies.length > 0) cookies = setCookies;
  nonce = res.headers.get('Nonce') ?? nonce;
  const text = await res.text();
  if (!res.ok || !res.headers.get('Content-Type')?.includes('application/json')) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as unknown;
}

const address = {
  first_name: 'Asha',
  last_name: 'Rao',
  address_1: '12 MG Road',
  city: 'Bengaluru',
  state: 'KA',
  postcode: '560001',
  country: 'IN',
  email: 'asha@example.com',
  phone: '9800000000',
};

try {
  const products = (await call('/products?per_page=1')) as Array<{ id: number; name: string }>;
  const product = products[0];
  if (!product) throw new Error('store has no products');
  await call('/cart');
  await call('/cart/add-item', {
    method: 'POST',
    body: JSON.stringify({ id: product.id, quantity: 1 }),
  });
  const order = (await call('/checkout', {
    method: 'POST',
    body: JSON.stringify({
      billing_address: address,
      shipping_address: address,
      payment_method: 'cod',
    }),
  })) as { order_id: number; status: string; payment_method: string };
  console.log(`order ${order.order_id} status=${order.status} payment=${order.payment_method}`);
  if (order.status !== 'processing' || order.payment_method !== 'cod') process.exit(1);
} catch (err) {
  console.error(`FAIL: ${(err as Error).message}`);
  process.exit(1);
}

export {};
