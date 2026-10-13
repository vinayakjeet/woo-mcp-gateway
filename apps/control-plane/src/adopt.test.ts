import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAndSeed } from './migrate-run.js';
import type { SeedServer } from './seed.js';
import type { StoreDefaults } from './store-values.js';
import { freshDatabase } from './test-db.js';
import { testStoreDefaults } from './test-stores.js';

const base = process.env.TEST_DATABASE_URL;
const kek = randomBytes(32);
const SERVERS: SeedServer[] = [
  {
    slug: 'main',
    name: 'Main Store',
    url: 'http://woo-mcp.store-main.svc.cluster.local:8080/mcp',
    kind: 'store',
    managed: true,
    protocolMode: 'auto',
    auth: { type: 'bearer', secret: 'main-token' },
  },
  {
    slug: 'fx',
    name: 'Currency',
    url: 'http://fx-mcp.platform.svc.cluster.local:8080/mcp',
    kind: 'system',
    managed: true,
    protocolMode: 'auto',
    auth: { type: 'bearer', secret: 'fx-token' },
  },
];

describe.skipIf(!base)('adoptSeededStores (needs TEST_DATABASE_URL)', () => {
  let url: string;
  let client: pg.Client;
  const run = (storeDefaults?: StoreDefaults) =>
    migrateAndSeed({
      databaseUrl: url,
      kek,
      adminEmail: 'admin@example.com',
      adminPassword: 'pw-admin-12345',
      seedServers: SERVERS,
      storeDefaults,
    });
  const storeCount = async () =>
    (await client.query<{ n: number }>('select count(*)::int as n from stores')).rows[0]!.n;

  beforeAll(async () => {
    url = await freshDatabase(base!, 'woo_adopt_test');
    client = new pg.Client({ connectionString: url });
    await client.connect();
  }, 30_000);
  afterAll(async () => {
    await client.end();
  });

  it('adopts nothing without store values', async () => {
    await run();
    expect(await storeCount()).toBe(0);
  });

  it('adopts main as a ready store owned by the admin and links its server', async () => {
    await run(testStoreDefaults());
    const s = await client.query(
      `select s.id, s.slug, s.name, s.status, s.namespace, s.release, s.url, s.last_step,
              s.ready_at is not null as ready, s.deadline_at, u.email::text as owner
       from stores s join users u on u.id = s.owner_user_id`,
    );
    expect(s.rows).toEqual([
      {
        id: expect.any(String),
        slug: 'main',
        name: 'Main Store',
        status: 'ready',
        namespace: 'store-main',
        release: 'store-main',
        url: 'http://main.shop.127.0.0.1.nip.io',
        last_step: 'adopted',
        ready: true,
        deadline_at: null,
        owner: 'admin@example.com',
      },
    ]);
    const m = await client.query('select slug, store_id from mcp_servers order by slug');
    expect(m.rows).toEqual([
      { slug: 'fx', store_id: null },
      { slug: 'main', store_id: s.rows[0].id },
    ]);
  });

  it('keeps one row across restarts', async () => {
    await run(testStoreDefaults());
    await run(testStoreDefaults());
    expect(await storeCount()).toBe(1);
  });
});
