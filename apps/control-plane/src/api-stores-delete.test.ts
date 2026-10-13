import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, listen, testApi, userWithSession } from './test-app.js';
import { insertStore, testStoreDefaults } from './test-stores.js';

type Who = { id: string; cookie: string };

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'stores API: delete (needs TEST_DATABASE_URL)',
  () => {
    let t: Awaited<ReturnType<typeof testApi>>;
    let admin: Who;
    let member: Who;
    let other: Who;
    beforeAll(async () => {
      t = await testApi('woo_api_stores_delete_test', {
        provisioner: { storeDefaults: testStoreDefaults(), maxStoresPerUser: 3 },
      });
      admin = await userWithSession(t.pool, 'admin@example.com', 'admin');
      member = await userWithSession(t.pool, 'member@example.com');
      other = await userWithSession(t.pool, 'other@example.com');
    }, 30_000);
    afterAll(async () => {
      await t.close();
    });
    const del = (id: string, cookie: string) =>
      call(t.app, 'DELETE', `/api/stores/${id}`, { cookie });
    const add = (owner: string, slug: string, status: string) =>
      insertStore(t.pool, t.kek, owner, slug, { status });

    it('marks a ready store deleting, drops its server and notifies both channels', async () => {
      const id = await add(member.id, 'gone-soon', 'ready');
      const sid = (await t.pool.query('select id from mcp_servers where store_id = $1', [id]))
        .rows[0].id;
      const reg = await listen(t.url, 'registry_changed');
      const st = await listen(t.url, 'stores_changed');
      try {
        const r = await del(id, member.cookie);
        expect(r.statusCode).toBe(202);
        expect(r.json().store).toMatchObject({
          status: 'deleting',
          lastStep: 'queued',
          deletable: false,
        });
        expect(
          (await t.pool.query('select 1 from mcp_servers where id = $1', [sid])).rowCount,
        ).toBe(0);
        expect(await reg.waitFor(1)).toEqual([sid]);
        expect(await st.waitFor(1)).toEqual([id]);
        expect((await del(id, member.cookie)).statusCode).toBe(202);
      } finally {
        await reg.close();
        await st.close();
      }
    });

    it("lets an admin delete a member's failed store", async () => {
      const id = await add(member.id, 'broken', 'failed');
      expect((await del(id, admin.cookie)).statusCode).toBe(202);
    });

    it('refuses a provisioning store and the seeded main store', async () => {
      const p = await add(member.id, 'busy', 'provisioning');
      const r = await del(p, member.cookie);
      expect([r.statusCode, r.json()]).toEqual([409, { error: 'not_deletable' }]);
      const m = await add(admin.id, 'main', 'ready');
      const rm = await del(m, admin.cookie);
      expect([rm.statusCode, rm.json()]).toEqual([409, { error: 'seeded_store' }]);
    });

    it("hides other members' stores and unknown ids", async () => {
      const id = await add(member.id, 'private', 'ready');
      expect((await del(id, other.cookie)).statusCode).toBe(404);
      expect((await del('00000000-0000-4000-8000-000000000000', admin.cookie)).statusCode).toBe(
        404,
      );
      expect((await del('not-a-uuid', admin.cookie)).statusCode).toBe(404);
    });
  },
);

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'stores API delete with the provisioner off',
  () => {
    it('answers 503', async () => {
      const t = await testApi('woo_api_stores_delete_off_test');
      try {
        const u = await userWithSession(t.pool, 'admin@example.com', 'admin');
        const id = await insertStore(t.pool, t.kek, u.id, 'idle', { status: 'ready' });
        const r = await call(t.app, 'DELETE', `/api/stores/${id}`, { cookie: u.cookie });
        expect([r.statusCode, r.json()]).toEqual([503, { error: 'provisioner_disabled' }]);
      } finally {
        await t.close();
      }
    }, 30_000);
  },
);
