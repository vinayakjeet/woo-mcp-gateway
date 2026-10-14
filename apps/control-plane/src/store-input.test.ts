import { describe, expect, it } from 'vitest';
import { deriveStoreSlug, parseIdempotencyKey, parseStoreCreate } from './store-input.js';

describe('deriveStoreSlug', () => {
  it.each([
    ['Second Store', 'second-store'],
    ['  Shop #2 -- Pune! ', 'shop-2-pune'],
    ['Café Royale', 'cafe-royale'],
    [`Bob's "Shop": #1`, 'bob-s-shop-1'],
    ['A very long store name that goes on', 'a-very-long-store-na'],
    ['Abcdefghijklmnopqrs tuv', 'abcdefghijklmnopqrs'],
    ['Main', 'main'],
  ])('%s gives %s', (name, slug) => {
    expect(deriveStoreSlug(name)).toBe(slug);
  });
  it.each(['ab', '24 Seven', '!!!', 'दुकान', 'x__'])('%s gives no valid slug', (name) => {
    expect(deriveStoreSlug(name)).toBeNull();
  });
});

describe('parseStoreCreate', () => {
  it('trims the name and derives the slug', () => {
    expect(parseStoreCreate({ name: '  Second Store ' })).toEqual({
      ok: true,
      value: { name: 'Second Store', slug: 'second-store' },
    });
  });
  it('refuses a name that gives the reserved slug main', () => {
    expect(parseStoreCreate({ name: 'Main' })).toEqual({ ok: false, error: 'slug_reserved' });
  });
  it.each([
    {},
    { name: '' },
    { name: 'x'.repeat(61) },
    { name: 'ab' },
    { name: 'Shop\nTwo' },
    { name: 42 },
    null,
    'Shop',
  ])('refuses %j', (body) => {
    expect(parseStoreCreate(body)).toEqual({ ok: false, error: 'invalid_name' });
  });
});

describe('parseIdempotencyKey', () => {
  it('treats a missing header as no key', () => {
    expect(parseIdempotencyKey(undefined)).toEqual({ ok: true, key: null });
  });
  it('accepts a UUID', () => {
    const k = '0f8e2c1a-6b1d-4c55-9a43-2d9b7a51c0de';
    expect(parseIdempotencyKey(k)).toEqual({ ok: true, key: k });
  });
  it.each(['', 'has space', 'x'.repeat(201), 'ключ', ['a', 'b']])('refuses %j', (h) => {
    expect(parseIdempotencyKey(h)).toEqual({ ok: false });
  });
});
