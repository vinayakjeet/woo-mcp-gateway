import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KubeError } from './kube.js';
import {
  JOB_SELECT,
  provisionStore,
  VERIFY_ATTEMPTS,
  type ReconcileDeps,
  type StoreJob,
} from './reconcile.js';
import { listen } from './test-app.js';
import {
  FakeHelm,
  FakeKube,
  FakeProbe,
  insertStore,
  quietLog,
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

  const setup = (over: Partial<ReconcileDeps> = {}) => {
    const helm = new FakeHelm();
    const kube = new FakeKube();
    const probe = new FakeProbe();
    const d: ReconcileDeps = {
      pool: db.pool,
      kek: db.kek,
      helm,
      kube,
      probe: probe.fn,
      defaults: testStoreDefaults(),
      chartPath: '/charts/store',
      workDir,
      log: quietLog,
      sleep: async () => {},
      ...over,
    };
    return { helm, kube, probe, d };
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

  it('checks get_info before ready and enables the server only after it answered', async () => {
    const { helm, probe, d } = setup();
    const id = await add('zeta');
    const seen: unknown[] = [];
    probe.onCall = async () => {
      seen.push([(await row(id)).status, (await server(id)).enabled]);
    };
    await provisionStore(d, await job(id));
    expect(probe.calls).toEqual([
      { url: 'http://woo-mcp.store-zeta.svc.cluster.local:8080/mcp', token: 'tok-zeta' },
    ]);
    expect(seen).toEqual([['provisioning', false]]);
    expect(helm.calls.at(-1)).toMatch(/^install/);
    expect(await row(id)).toMatchObject({ status: 'ready', last_step: 'ready' });
    expect((await server(id)).enabled).toBe(true);
  });

  it('waits inside the pass while get_info does not answer yet', async () => {
    const { probe, d } = setup();
    probe.failTimes = 3;
    const id = await add('theta');
    await provisionStore(d, await job(id));
    expect(probe.calls).toHaveLength(4);
    expect((await row(id)).status).toBe('ready');
  });

  it('stays provisioning with the server off when get_info never answers, then recovers', async () => {
    const { helm, probe, d } = setup();
    probe.failTimes = 1000;
    probe.failWith = 'boom tok-eta refused';
    const id = await add('eta');
    await provisionStore(d, await job(id));
    expect(probe.calls).toHaveLength(VERIFY_ATTEMPTS);
    expect(await row(id)).toMatchObject({
      status: 'provisioning',
      last_step: 'verify',
      status_reason: `Step verify failed on attempt 1: get_info did not answer after ${VERIFY_ATTEMPTS} tries: boom *** refused`,
    });
    expect((await server(id)).enabled).toBe(false);
    // The release is deployed now, so the next pass only verifies.
    probe.failTimes = 0;
    probe.calls.length = 0;
    await provisionStore(d, await job(id));
    expect(helm.calls.filter((c) => c.startsWith('install'))).toHaveLength(1);
    expect(probe.calls).toHaveLength(1);
    expect((await row(id)).status).toBe('ready');
    expect((await server(id)).enabled).toBe(true);
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
