import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KubeError } from './kube.js';
import { JOB_SELECT, provisionStore, type ReconcileDeps, type StoreJob } from './reconcile.js';
import { listen } from './test-app.js';
import {
  FakeHelm,
  FakeKube,
  connectAll,
  insertStore,
  quietLog,
  reportStatus,
  storeDb,
  testStoreDefaults,
} from './test-stores.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('provisionStore (needs TEST_DATABASE_URL)', () => {
  let db: Awaited<ReturnType<typeof storeDb>>;
  let workDir: string;
  beforeAll(async () => {
    db = await storeDb('woo_reconcile_test');
    workDir = await mkdtemp(join(tmpdir(), 'reconcile-'));
  }, 30_000);
  afterAll(async () => {
    await db.pool.end();
    await rm(workDir, { recursive: true, force: true });
  });

  // The fake gateway: each sleep is one poll interval. onSleep decides what the gateway reports
  // meanwhile, and by default it connects every enabled store server at once.
  const setup = (over: Partial<ReconcileDeps> = {}) => {
    const helm = new FakeHelm();
    const kube = new FakeKube();
    const gw: { clock: number; sleeps: number; onSleep: (n: number) => Promise<void> } = {
      clock: Date.now(),
      sleeps: 0,
      onSleep: () => connectAll(db.pool),
    };
    const d: ReconcileDeps = {
      pool: db.pool,
      kek: db.kek,
      helm,
      kube,
      defaults: testStoreDefaults(),
      chartPath: '/charts/store',
      workDir,
      log: quietLog,
      now: () => new Date(gw.clock),
      sleep: async (ms) => {
        gw.clock += ms;
        await gw.onSleep(++gw.sleeps);
      },
      ...over,
    };
    return { helm, kube, gw, d };
  };
  const job = async (id: string) =>
    (await db.pool.query<StoreJob>(`${JOB_SELECT} where id = $1`, [id])).rows[0]!;
  const row = async (id: string) =>
    (
      await db.pool.query(
        'select status, status_reason, last_step, attempt, url, ready_at from stores where id = $1',
        [id],
      )
    ).rows[0];
  const server = async (id: string) =>
    (await db.pool.query('select id, enabled from mcp_servers where store_id = $1', [id])).rows[0];
  const add = (slug: string, over = {}) => insertStore(db.pool, db.kek, db.owner, slug, over);

  it('installs a new store, then enables its server and notifies the gateway', async () => {
    const { helm, kube, d } = setup();
    const id = await add('alpha');
    const l = await listen(db.url, 'registry_changed');
    try {
      await provisionStore(d, await job(id));
      expect(kube.namespaces.get('store-alpha')).toEqual({
        'urumi.io/store': 'alpha',
        'urumi.io/managed': 'true',
        'pod-security.kubernetes.io/enforce': 'baseline',
      });
      expect(helm.calls).toEqual([
        'status store-alpha/store-alpha',
        'install store-alpha/store-alpha timeout=600',
      ]);
      expect(JSON.parse(helm.values[0]!)).toMatchObject({
        slug: 'alpha',
        storeName: 'Store alpha',
        mcp: { sharedToken: 'tok-alpha' },
      });
      expect(await row(id)).toMatchObject({
        status: 'ready',
        last_step: 'ready',
        url: 'http://alpha.shop.127.0.0.1.nip.io',
      });
      const s = await server(id);
      expect(s.enabled).toBe(true);
      expect(await l.waitFor(1)).toEqual([s.id]);
    } finally {
      await l.close();
    }
  });

  it('deletes the values file even when the install fails', async () => {
    const { helm, d } = setup();
    helm.failNext = 1;
    const id = await add('beta');
    await provisionStore(d, await job(id));
    expect(await readdir(workDir)).toEqual([]);
    expect(await row(id)).toMatchObject({
      status: 'provisioning',
      last_step: 'install',
      status_reason: 'Step install failed on attempt 1: Error: INSTALLATION FAILED: boom',
    });
    expect((await server(id)).enabled).toBe(false);
  });

  it('skips the install when the release is already deployed', async () => {
    const { helm, d } = setup();
    helm.releases.set('store-gamma/store-gamma', 'deployed');
    const id = await add('gamma');
    await provisionStore(d, await job(id));
    expect(helm.calls).toEqual(['status store-gamma/store-gamma']);
    expect((await row(id)).status).toBe('ready');
  });

  it('retries a failed release and gives up after 3 attempts, keeping the release', async () => {
    const { helm, d } = setup();
    helm.failNext = 3;
    const id = await add('delta');
    await provisionStore(d, await job(id));
    await provisionStore(d, await job(id));
    await provisionStore(d, await job(id));
    expect(await row(id)).toMatchObject({ status: 'provisioning', attempt: 2 });
    await provisionStore(d, await job(id));
    expect(await row(id)).toMatchObject({
      status: 'failed',
      attempt: 3,
      status_reason: 'Install failed 3 times. The last release is kept for inspection.',
    });
    expect(helm.calls.filter((c) => c.startsWith('install'))).toHaveLength(3);
    expect(helm.calls.filter((c) => c.startsWith('uninstall'))).toHaveLength(2);
    expect(helm.releases.get('store-delta/store-delta')).toBe('failed');
  });

  it('enables the server, waits for the gateway to connect it, and only then marks ready', async () => {
    const { gw, d } = setup();
    const id = await add('zeta');
    const l = await listen(db.url, 'registry_changed');
    const seen: unknown[] = [];
    gw.onSleep = async () => {
      const r = await row(id);
      seen.push([r.status, r.last_step, (await server(id)).enabled]);
      await reportStatus(db.pool, id, 'connected');
    };
    try {
      await provisionStore(d, await job(id));
      expect(seen).toEqual([['provisioning', 'verify', true]]);
      expect(await row(id)).toMatchObject({ status: 'ready', last_step: 'ready' });
      expect(await l.waitFor(1)).toEqual([(await server(id)).id]);
    } finally {
      await l.close();
    }
  });

  it('keeps polling while the gateway reports the server unreachable', async () => {
    const { gw, d } = setup();
    const id = await add('theta');
    gw.onSleep = async (n) => {
      if (n < 3) await reportStatus(db.pool, id, 'unreachable', 'refused', 'Server theta refused');
      else await reportStatus(db.pool, id, 'connected');
    };
    await provisionStore(d, await job(id));
    expect(gw.sleeps).toBe(3);
    expect((await row(id)).status).toBe('ready');
  });

  it('fails at the deadline with the gateway error and turns the server off again', async () => {
    const { gw, d } = setup();
    const id = await add('eta', { deadlineAt: new Date(gw.clock + 10_000) });
    gw.onSleep = () => reportStatus(db.pool, id, 'unreachable', 'timeout', 'Server eta is busy');
    const l = await listen(db.url, 'registry_changed');
    try {
      await provisionStore(d, await job(id));
      expect(gw.sleeps).toBe(5);
      expect(await row(id)).toMatchObject({
        status: 'failed',
        last_step: 'verify',
        status_reason: 'The gateway could not connect to the store: timeout: Server eta is busy',
      });
      expect((await server(id)).enabled).toBe(false);
      expect(await l.waitFor(2)).toHaveLength(2);
    } finally {
      await l.close();
    }
  });

  it('says so when the gateway never reported on the server before the deadline', async () => {
    const { gw, d } = setup();
    const id = await add('iota', { deadlineAt: new Date(gw.clock + 4_000) });
    gw.onSleep = async () => {};
    await provisionStore(d, await job(id));
    expect(await row(id)).toMatchObject({
      status: 'failed',
      status_reason: 'The gateway did not report on the store before its deadline',
    });
    expect((await server(id)).enabled).toBe(false);
  });

  it('records a Kubernetes refusal and stays provisioning', async () => {
    const { kube, helm, d } = setup();
    kube.applyError = new KubeError(403, 'Forbidden');
    const id = await add('epsilon');
    await provisionStore(d, await job(id));
    expect(await row(id)).toMatchObject({
      status: 'provisioning',
      status_reason: 'Step namespace failed on attempt 1: Kubernetes API answered 403 Forbidden',
    });
    expect(helm.calls).toEqual([]);
  });
});
