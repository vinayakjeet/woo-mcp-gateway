import { decryptSecret } from '@woo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, listen, testApi, userWithSession } from './test-app.js';
import { testStoreDefaults } from './test-stores.js';

type Who = { id: string; cookie: string };
const on = { provisioner: { storeDefaults: testStoreDefaults(), maxStoresPerUser: 3 } };

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'stores API: list and create (needs TEST_DATABASE_URL)',
  () => {
    let t: Awaited<ReturnType<typeof testApi>>;
    let admin: Who;
    let member: Who;
    let other: Who;
    beforeAll(async () => {
      t = await testApi('woo_api_stores_test', on);
      admin = await userWithSession(t.pool, 'admin@example.com', 'admin');
      member = await userWithSession(t.pool, 'member@example.com');
      other = await userWithSession(t.pool, 'other@example.com');
    }, 30_000);
    afterAll(async () => {
      await t.close();
    });

    const create = (name: string, cookie: string, key?: string) =>
      call(t.app, 'POST', '/api/stores', {
        cookie,
        body: { name },
        headers: key ? { 'idempotency-key': key } : {},
      });

    it('creates a provisioning store with a disabled managed server and a notify', async () => {
      const l = await listen(t.url, 'stores_changed');
      try {
        const r = await create('Second Store', member.cookie, 'k-second');
        expect(r.statusCode).toBe(202);
        const s = r.json().store;
        expect(s).toMatchObject({
          slug: 'second-store',
          name: 'Second Store',
          status: 'provisioning',
          lastStep: 'queued',
          url: null,
          attempt: 0,
          owner: { id: member.id, email: 'member@example.com' },
          deletable: false,
        });
        const left = new Date(s.deadlineAt).getTime() - Date.now();
        expect(left).toBeGreaterThan(14 * 60_000);
        expect(left).toBeLessThanOrEqual(15 * 60_000 + 5000);
        const row = await t.pool.query(
          `select s.namespace, s.release, s.idempotency_key, m.kind, m.managed, m.enabled,
                  m.auth_type, m.protocol_mode, m.url, m.auth_secret_enc
           from stores s join mcp_servers m on m.store_id = s.id where s.id = $1`,
          [s.id],
        );
        expect(row.rows[0]).toMatchObject({
          namespace: 'store-second-store',
          release: 'store-second-store',
          idempotency_key: 'k-second',
          kind: 'store',
          managed: true,
          enabled: false,
          auth_type: 'bearer',
          protocol_mode: 'auto',
          url: 'http://woo-mcp.store-second-store.svc.cluster.local:8080/mcp',
        });
        expect(decryptSecret(row.rows[0].auth_secret_enc, t.kek, 'second-store')).toMatch(
          /^[0-9a-f]{64}$/,
        );
        expect(await l.waitFor(1)).toEqual([s.id]);
      } finally {
        await l.close();
      }
    });

    it('returns the existing store for the same key, even with another name', async () => {
      const a = await create('Key Store', member.cookie, 'k-same');
      const b = await create('Key Store Renamed', member.cookie, 'k-same');
      expect([a.statusCode, b.statusCode]).toEqual([202, 200]);
      expect(b.json().store.id).toBe(a.json().store.id);
      expect(b.json().store.slug).toBe('key-store');
    });

    it('gives one store for parallel requests with one key', async () => {
      const rs = await Promise.all([1, 2, 3].map(() => create('Burst Store', other.cookie, 'k-b')));
      expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 200, 202]);
      expect(new Set(rs.map((r) => r.json().store.id)).size).toBe(1);
    });

    it('enforces the per-user limit, and a replay still answers at the limit', async () => {
      expect((await create('Third Store', member.cookie)).statusCode).toBe(202);
      const r = await create('Fourth Store', member.cookie);
      expect([r.statusCode, r.json()]).toEqual([409, { error: 'store_limit', limit: 3 }]);
      expect((await create('Second Store', member.cookie, 'k-second')).statusCode).toBe(200);
      const left = await t.pool.query("select 1 from stores where slug = 'fourth-store'");
      expect(left.rowCount).toBe(0);
    });

    it('holds the limit under parallel creates', async () => {
      const u = await userWithSession(t.pool, 'racer@example.com');
      const names = ['Race A', 'Race B', 'Race C', 'Race D', 'Race E'];
      const rs = await Promise.all(names.map((n) => create(n, u.cookie)));
      expect(rs.map((r) => r.statusCode).sort()).toEqual([202, 202, 202, 409, 409]);
    });

    it('refuses a taken address, also one a server uses, and leaves no row', async () => {
      expect((await create('Second-Store', admin.cookie)).json()).toEqual({ error: 'name_taken' });
      await t.pool.query(
        "insert into mcp_servers (slug, name, url, kind) values ('shop-x', 'X', 'http://x.example/mcp', 'external')",
      );
      const r = await create('Shop X', admin.cookie);
      expect([r.statusCode, r.json()]).toEqual([409, { error: 'name_taken' }]);
      expect((await t.pool.query("select 1 from stores where slug = 'shop-x'")).rowCount).toBe(0);
    });

    it('validates the name and the key', async () => {
      expect((await create('Main', admin.cookie)).json()).toEqual({ error: 'slug_reserved' });
      expect((await create('ab', admin.cookie)).json()).toEqual({ error: 'invalid_name' });
      const bad = await create('Good Name', admin.cookie, 'has space');
      expect([bad.statusCode, bad.json()]).toEqual([400, { error: 'invalid_idempotency_key' }]);
    });

    it('lists own stores for members and all stores for admins, never a token', async () => {
      const mine = (await call(t.app, 'GET', '/api/stores', { cookie: member.cookie })).json();
      expect(mine.stores.map((s: { slug: string }) => s.slug).sort()).toEqual([
        'key-store',
        'second-store',
        'third-store',
      ]);
      const all = await call(t.app, 'GET', '/api/stores', { cookie: admin.cookie });
      expect(all.json().stores.map((s: { slug: string }) => s.slug)).toEqual(
        expect.arrayContaining(['burst-store', 'second-store', 'race-a']),
      );
      expect(all.body).not.toMatch(/[0-9a-f]{64}/);
    });

    it('needs a session', async () => {
      expect((await call(t.app, 'GET', '/api/stores')).statusCode).toBe(401);
      const r = await call(t.app, 'POST', '/api/stores', { body: { name: 'Anon Shop' } });
      expect(r.statusCode).toBe(401);
    });
  },
);

describe.skipIf(!process.env.TEST_DATABASE_URL)('stores API with the provisioner off', () => {
  it('refuses creates with 503 and still lists', async () => {
    const t = await testApi('woo_api_stores_off_test');
    try {
      const u = await userWithSession(t.pool, 'member@example.com');
      const r = await call(t.app, 'POST', '/api/stores', {
        cookie: u.cookie,
        body: { name: 'Any Shop' },
      });
      expect([r.statusCode, r.json()]).toEqual([503, { error: 'provisioner_disabled' }]);
      const l = await call(t.app, 'GET', '/api/stores', { cookie: u.cookie });
      expect(l.json()).toEqual({ stores: [] });
    } finally {
      await t.close();
    }
  }, 30_000);
});
