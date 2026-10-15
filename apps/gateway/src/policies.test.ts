import { schema } from '@woo/core/db';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PolicyStore } from './policies.js';
import { migratedDatabase, TEST_DATABASE_URL } from './test-db.js';
import type { Db } from './types.js';

describe.skipIf(!TEST_DATABASE_URL)('PolicyStore (needs TEST_DATABASE_URL)', () => {
  let pool: pg.Pool;
  let db: Db;
  beforeAll(async () => {
    ({ pool, db } = await migratedDatabase('woo_gateway_policies_test'));
  });
  afterAll(async () => {
    await pool.end();
  });

  it('denies a member and allows an admin before anything is loaded', () => {
    const store = new PolicyStore(db);
    expect(store.allows('member', 'main', 'list_orders')).toBe(false);
    expect(store.allows('admin', 'main', 'list_orders')).toBe(true);
  });

  it('applies the rules it loaded and picks up later changes on the next load', async () => {
    const store = new PolicyStore(db);
    await db.insert(schema.toolPolicies).values({
      role: 'member',
      serverPattern: 'main',
      toolPattern: 'list_*',
      effect: 'allow',
    });
    await store.load();
    expect(store.allows('member', 'main', 'list_orders')).toBe(true);
    expect(store.allows('member', 'main', 'create_product')).toBe(false);
    await db.insert(schema.toolPolicies).values({
      role: 'member',
      serverPattern: 'main',
      toolPattern: 'list_orders',
      effect: 'deny',
      priority: 5,
    });
    expect(store.allows('member', 'main', 'list_orders')).toBe(true);
    await store.load();
    expect(store.allows('member', 'main', 'list_orders')).toBe(false);
  });
});
