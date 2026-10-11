import { describe, expect, it } from 'vitest';
import {
  createProductInput,
  getOrderInput,
  listOrdersInput,
  listProductsInput,
  updateOrderStatusInput,
} from './schemas.js';

describe('list_products', () => {
  it('applies defaults', () => {
    expect(listProductsInput.parse({})).toEqual({ status: 'any', page: 1, per_page: 20 });
  });
  it.each([{ per_page: 0 }, { per_page: 51 }, { page: 0 }, { status: 'trash' }, { per_page: 2.5 }])(
    'rejects %j',
    (v) => {
      expect(listProductsInput.safeParse(v).success).toBe(false);
    },
  );
});

describe('create_product', () => {
  const ok = { name: 'Mug', regular_price: '199.50' };
  it('accepts a minimal product and defaults to publish', () => {
    expect(createProductInput.parse(ok)).toMatchObject({ ...ok, status: 'publish' });
  });
  it.each(['199.5', '10', '0.99'])('accepts price %s', (p) => {
    expect(createProductInput.safeParse({ ...ok, regular_price: p }).success).toBe(true);
  });
  it.each(['1.999', '-1', '1,00', '', ' 10', '1e3', '.5'])('rejects price %j', (p) => {
    expect(createProductInput.safeParse({ ...ok, regular_price: p }).success).toBe(false);
  });
  it('rejects empty and 201-char names', () => {
    expect(createProductInput.safeParse({ ...ok, name: '' }).success).toBe(false);
    expect(createProductInput.safeParse({ ...ok, name: 'x'.repeat(201) }).success).toBe(false);
    expect(createProductInput.safeParse({ ...ok, name: 'x'.repeat(200) }).success).toBe(true);
  });
  it('rejects negative or fractional stock and pending status', () => {
    expect(createProductInput.safeParse({ ...ok, stock_quantity: -1 }).success).toBe(false);
    expect(createProductInput.safeParse({ ...ok, stock_quantity: 1.5 }).success).toBe(false);
    expect(createProductInput.safeParse({ ...ok, status: 'pending' }).success).toBe(false);
  });
});

describe('list_orders', () => {
  it('accepts presets, ISO bounds with offsets, and any', () => {
    expect(listOrdersInput.parse({ date: 'today' })).toMatchObject({
      date: 'today',
      page: 1,
      per_page: 20,
    });
    expect(
      listOrdersInput.safeParse({ after: '2026-10-01T00:00:00+05:30', status: 'any' }).success,
    ).toBe(true);
  });
  it.each([
    { date: 'tomorrow' },
    { after: '2026-10-01' },
    { after: 'yesterday' },
    { status: 'shipped' },
  ])('rejects %j', (v) => {
    expect(listOrdersInput.safeParse(v).success).toBe(false);
  });
});

describe('get_order and update_order_status', () => {
  it('needs a positive integer id', () => {
    expect(getOrderInput.safeParse({ order_id: 0 }).success).toBe(false);
    expect(getOrderInput.safeParse({ order_id: '12' }).success).toBe(false);
    expect(getOrderInput.safeParse({ order_id: 12 }).success).toBe(true);
  });
  it('allows only the 7 settable statuses', () => {
    expect(
      updateOrderStatusInput.safeParse({ order_id: 1, status: 'completed', note: 'packed' })
        .success,
    ).toBe(true);
    expect(updateOrderStatusInput.safeParse({ order_id: 1, status: 'any' }).success).toBe(false);
    expect(
      updateOrderStatusInput.safeParse({ order_id: 1, status: 'checkout-draft' }).success,
    ).toBe(false);
  });
});
