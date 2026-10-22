import { describe, expect, it } from 'vitest';
import { createdProduct, orderDetail, orderSummary, productSummary } from './mappers.js';

const order = {
  id: 41,
  number: '41',
  status: 'processing',
  currency: 'INR',
  total: '398.00',
  subtotal: '398.00',
  total_tax: '0.00',
  shipping_total: '0.00',
  discount_total: '0.00',
  date_created: '2026-10-11T08:12:00',
  date_created_gmt: '2026-10-11T02:42:00',
  date_modified: '2026-10-11T08:12:05',
  date_paid: null,
  date_completed: null,
  payment_method: 'cod',
  payment_method_title: 'Cash on delivery',
  billing: {
    first_name: 'Asha',
    last_name: 'Rao',
    email: 'asha@example.com',
    phone: '+919800000000',
    address_1: '12 MG Road',
    address_2: '',
    city: 'Bengaluru',
    postcode: '560001',
    state: 'KA',
    country: 'IN',
  },
  shipping: { first_name: 'Asha', address_1: '12 MG Road', city: 'Bengaluru' },
  customer_ip_address: '10.42.0.1',
  line_items: [{ id: 1, name: 'Mug', quantity: 2, total: '398.00', sku: 'MUG-1', product_id: 5 }],
};

describe('order mappers', () => {
  it.each([
    ['summary', orderSummary],
    ['detail', orderDetail],
  ] as const)('%s never contains email, phone, street or IP', (_n, fn) => {
    const s = JSON.stringify(fn(order));
    for (const secret of [
      'asha@example.com',
      '+919800000000',
      '12 MG Road',
      '560001',
      '10.42.0.1',
      'Rao',
    ]) {
      expect(s).not.toContain(secret);
    }
  });
  it('summary has the documented fields', () => {
    expect(orderSummary(order)).toEqual({
      id: 41,
      number: '41',
      status: 'processing',
      total: '398.00',
      currency: 'INR',
      date_created: '2026-10-11T08:12:00',
      customer_first_name: 'Asha',
      items: [{ name: 'Mug', quantity: 2 }],
    });
  });
  it('detail has totals, payment title, dates, first name, city and line items', () => {
    expect(orderDetail(order)).toEqual({
      id: 41,
      status: 'processing',
      currency: 'INR',
      totals: {
        total: '398.00',
        subtotal: '398.00',
        tax: '0.00',
        shipping: '0.00',
        discount: '0.00',
      },
      payment_method_title: 'Cash on delivery',
      dates: {
        created: '2026-10-11T08:12:00',
        modified: '2026-10-11T08:12:05',
        paid: null,
        completed: null,
      },
      billing: { first_name: 'Asha', city: 'Bengaluru' },
      line_items: [{ name: 'Mug', sku: 'MUG-1', quantity: 2, total: '398.00' }],
    });
  });
});

describe('product mappers', () => {
  const p = {
    id: 5,
    name: 'Mug',
    sku: 'MUG-1',
    price: '199',
    regular_price: '199',
    status: 'publish',
    stock_status: 'instock',
    permalink: 'http://main.shop.127.0.0.1.nip.io/product/mug/',
    description: '<p>long</p>',
    images: [],
  };
  it('summary keeps only list fields', () => {
    expect(productSummary(p)).toEqual({
      id: 5,
      name: 'Mug',
      sku: 'MUG-1',
      price: '199',
      regular_price: '199',
      status: 'publish',
      stock_status: 'instock',
      permalink: 'http://main.shop.127.0.0.1.nip.io/product/mug/',
    });
  });
  it('created keeps id, name, price, status, permalink', () => {
    expect(createdProduct(p)).toEqual({
      id: 5,
      name: 'Mug',
      price: '199',
      status: 'publish',
      permalink: 'http://main.shop.127.0.0.1.nip.io/product/mug/',
    });
  });
});
