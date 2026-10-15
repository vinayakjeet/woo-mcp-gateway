import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInternalApp, buildPublicApp, type Deps } from './app.js';
import { createProvisionerMetrics } from './metrics.js';
import { insertStore, storeDb } from './test-stores.js';

const deps: Deps = {
  ping: async () => true,
  findUserByEmail: async () => null,
  createSession: async () => {},
};

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'provisioner metrics (needs TEST_DATABASE_URL)',
  () => {
    let db: Awaited<ReturnType<typeof storeDb>>;
    beforeAll(async () => {
      db = await storeDb('woo_metrics_test');
    }, 30_000);
    afterAll(() => db.pool.end());

    it('lists provisioner_stores for all four statuses, zero when none', async () => {
      const out = await createProvisionerMetrics(db.pool).render();
      for (const status of ['provisioning', 'ready', 'failed', 'deleting'])
        expect(out).toContain(`provisioner_stores{status="${status}"} 0\n`);
    });

    it('counts stores by status at scrape time', async () => {
      const m = createProvisionerMetrics(db.pool);
      await insertStore(db.pool, db.kek, db.owner, 'm-ready-1', { status: 'ready' });
      await insertStore(db.pool, db.kek, db.owner, 'm-ready-2', { status: 'ready' });
      await insertStore(db.pool, db.kek, db.owner, 'm-failed', { status: 'failed' });
      const out = await m.render();
      expect(out).toContain('provisioner_stores{status="ready"} 2\n');
      expect(out).toContain('provisioner_stores{status="failed"} 1\n');
      expect(out).toContain('provisioner_stores{status="provisioning"} 0\n');
      await insertStore(db.pool, db.kek, db.owner, 'm-prov');
      expect(await m.render()).toContain('provisioner_stores{status="provisioning"} 1\n');
    });

    it('observes the time a store took to become ready', async () => {
      const m = createProvisionerMetrics(db.pool);
      m.storeReady(75);
      m.storeReady(200);
      const out = await m.render();
      expect(out).toContain('provisioner_duration_seconds_bucket{le="60"} 0\n');
      expect(out).toContain('provisioner_duration_seconds_bucket{le="90"} 1\n');
      expect(out).toContain('provisioner_duration_seconds_bucket{le="300"} 2\n');
      expect(out).toContain('provisioner_duration_seconds_bucket{le="+Inf"} 2\n');
      expect(out).toContain('provisioner_duration_seconds_sum 275\n');
      expect(out).toContain('provisioner_duration_seconds_count 2\n');
    });

    it('answers the scrape with no store rows when the database fails, and prints no error text', async () => {
      const broken = {
        query: async () => {
          throw new Error('select * from stores where password = hunter2');
        },
      };
      const out = await createProvisionerMetrics(broken).render();
      expect(out).toContain('# TYPE provisioner_stores gauge\n');
      expect(out).not.toContain('provisioner_stores{');
      expect(out).not.toContain('hunter2');
    });

    it('serves /metrics on the internal app only', async () => {
      const m = createProvisionerMetrics(db.pool);
      const internal = buildInternalApp(deps, false, m);
      const res = await internal.inject('/metrics');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
      expect(res.body).toContain('# TYPE provisioner_stores gauge');
      expect(res.body).toContain('# TYPE provisioner_duration_seconds histogram');

      const pub = buildPublicApp(deps, { appOrigin: 'http://app.test', secureCookies: false });
      expect((await pub.inject('/metrics')).statusCode).toBe(404);
      expect((await buildInternalApp(deps).inject('/metrics')).statusCode).toBe(404);
    });
  },
);
