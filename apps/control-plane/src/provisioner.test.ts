import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HostedDeps } from './hosted-reconcile.js';
import { Provisioner } from './provisioner.js';
import type { ReconcileDeps } from './reconcile.js';
import {
  connectAll,
  FakeHelm,
  FakeKube,
  insertHosted,
  insertStore,
  quietLog,
  storeDb,
  TEST_HOSTED_CONFIG,
  testStoreDefaults,
  waitFor,
} from './test-stores.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Provisioner (needs TEST_DATABASE_URL)', () => {
  let db: Awaited<ReturnType<typeof storeDb>>;
  let workDir: string;
  let helm: FakeHelm;
  let kube: FakeKube;
  const running: Provisioner[] = [];
  beforeAll(async () => {
    db = await storeDb('woo_provisioner_test');
    workDir = await mkdtemp(join(tmpdir(), 'provisioner-'));
  }, 30_000);
  afterEach(async () => {
    for (const p of running.splice(0)) {
      await p.idle();
      await p.close();
    }
    // A store left mid-flight by one test must not be picked up by the next test's loop.
    await db.pool.query(
      "update stores set status = 'failed' where status in ('provisioning', 'deleting')",
    );
    await db.pool.query('delete from hosted_servers');
    await db.pool.query("delete from mcp_servers where kind = 'hosted'");
  });
  afterAll(async () => {
    await db.pool.end();
    await rm(workDir, { recursive: true, force: true });
  });

  const deps = (): ReconcileDeps => {
    helm = new FakeHelm();
    kube = new FakeKube();
    return {
      pool: db.pool,
      kek: db.kek,
      helm,
      kube,
      defaults: testStoreDefaults(),
      chartPath: '/charts/store',
      workDir,
      log: quietLog,
      sleep: async () => connectAll(db.pool),
      pollMs: 1,
      namespaceWaitMs: 10,
    };
  };
  const make = (
    d: ReconcileDeps,
    o: { tickMs?: number; lockRetryMs?: number; hosted?: HostedDeps } = {},
  ) => {
    const p = new Provisioner({ databaseUrl: db.url, deps: d, log: quietLog, ...o });
    running.push(p);
    return p;
  };
  const status = async (id: string) =>
    (await db.pool.query('select status from stores where id = $1', [id])).rows[0]?.status;
  const add = (slug: string, over = {}) => insertStore(db.pool, db.kek, db.owner, slug, over);

  it('lets one replica lead and hands over when it closes', async () => {
    const d = deps();
    const a = make(d, { lockRetryMs: 20 });
    const b = make(d, { lockRetryMs: 20 });
    await a.start();
    await b.start();
    expect([a.isLeader, b.isLeader]).toEqual([true, false]);
    await a.close();
    await waitFor(() => b.isLeader);
  });

  it('runs at most 3 stores at once and finishes all 5', async () => {
    const d = deps();
    let release!: () => void;
    helm.gate = new Promise((r) => (release = r));
    const ids = await Promise.all(['p1', 'p2', 'p3', 'p4', 'p5'].map((s) => add(s)));
    const p = make(d, { tickMs: 20 });
    await p.start();
    await waitFor(() => helm.active === 3);
    await sleep(150);
    expect([helm.active, p.inFlight]).toEqual([3, 3]);
    release();
    await waitFor(
      async () => (await Promise.all(ids.map(status))).every((s) => s === 'ready'),
      5000,
    );
    expect(helm.maxActive).toBe(3);
    expect(helm.calls.filter((c) => c.startsWith('install'))).toHaveLength(5);
  });

  it('starts a store on stores_changed without waiting for the tick', async () => {
    const p = make(deps(), { tickMs: 60_000 });
    await p.start();
    await p.idle();
    const id = await add('notified');
    await db.pool.query("select pg_notify('stores_changed', $1)", [id]);
    await waitFor(async () => (await status(id)) === 'ready', 2000);
  });

  it('never runs one store twice at once', async () => {
    const d = deps();
    let release!: () => void;
    helm.gate = new Promise((r) => (release = r));
    const id = await add('single');
    const p = make(d, { tickMs: 10 });
    await p.start();
    await waitFor(() => helm.active === 1);
    for (let i = 0; i < 20; i++) p.kick();
    await sleep(100);
    expect(helm.calls.filter((c) => c.startsWith('install'))).toHaveLength(1);
    release();
    await waitFor(async () => (await status(id)) === 'ready');
  });

  it('keeps the lock while helm runs after close, and frees it once idle', async () => {
    const d = deps();
    let release!: () => void;
    helm.gate = new Promise((r) => (release = r));
    const id = await add('restart');
    const a = new Provisioner({ databaseUrl: db.url, deps: d, log: quietLog, tickMs: 20 });
    await a.start();
    await waitFor(() => helm.active === 1);
    await a.close();
    const b = make(deps(), { lockRetryMs: 20 });
    await b.start();
    await sleep(150);
    expect(b.isLeader).toBe(false);
    release();
    await a.idle();
    await a.close();
    await waitFor(() => b.isLeader);
    expect(await status(id)).toBe('ready');
  });

  it('aborts in-flight helm when the lock session drops', async () => {
    const d = deps();
    helm.gate = new Promise(() => {});
    const id = await add('dropped');
    const p = make(d, { tickMs: 20, lockRetryMs: 60_000 });
    await p.start();
    await waitFor(() => helm.active === 1);
    await db.pool.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where application_name = 'control-plane-provisioner' and datname = current_database()`,
    );
    await waitFor(() => helm.aborted === 1);
    expect(p.isLeader).toBe(false);
    await p.idle();
    const r = await db.pool.query('select status, status_reason from stores where id = $1', [id]);
    expect(r.rows[0]).toEqual({
      status: 'provisioning',
      status_reason: 'Step install failed on attempt 1: aborted',
    });
  });

  it('tears down deleting stores', async () => {
    const d = deps();
    const id = await add('bye', { status: 'deleting' });
    kube.namespaces.set('store-bye', {});
    const p = make(d, { tickMs: 20 });
    await p.start();
    await waitFor(async () => (await status(id)) === undefined);
    expect(helm.calls).toContain('uninstall store-bye/store-bye');
    expect(kube.calls).toContain('delete store-bye');
  });

  it('tears down a deleting store whose creation deadline is long past', async () => {
    const d = deps();
    const old = new Date(Date.now() - 3600_000);
    const id = await add('bye-late', { status: 'deleting', deadlineAt: old });
    kube.namespaces.set('store-bye-late', {});
    const p = make(d, { tickMs: 20 });
    await p.start();
    await waitFor(async () => (await status(id)) === undefined);
    expect(helm.calls).toEqual(['uninstall store-bye-late/store-bye-late']);
  });

  const hostedDeps = (d: ReconcileDeps): HostedDeps => ({
    pool: db.pool,
    kek: db.kek,
    kube: d.kube,
    config: TEST_HOSTED_CONFIG,
    log: quietLog,
  });
  const hostedStatus = async (slug: string) =>
    (await db.pool.query('select status from hosted_servers where slug = $1', [slug])).rows[0]
      ?.status;

  it('runs a hosted pass while 3 stores are in flight', async () => {
    const d = deps();
    let release!: () => void;
    helm.gate = new Promise((r) => (release = r));
    await Promise.all(['h1', 'h2', 'h3', 'h4'].map((s) => add(s)));
    await insertHosted(db.pool, db.kek, db.owner, 'hostedfx');
    const p = make(d, { tickMs: 20, hosted: hostedDeps(d) });
    await p.start();
    await waitFor(() => helm.active === 3);
    await waitFor(() => kube.applied.some((a) => a.kind === 'Deployment'));
    expect([helm.active, p.inFlight]).toEqual([3, 3]);
    release();
  });

  it('starts a hosted pass on hosted_changed without waiting for the tick', async () => {
    const d = deps();
    const p = make(d, { tickMs: 60_000, hosted: hostedDeps(d) });
    await p.start();
    await p.idle();
    const { id } = await insertHosted(db.pool, db.kek, db.owner, 'kicked');
    await db.pool.query("select pg_notify('hosted_changed', $1)", [id]);
    await waitFor(() => kube.applied.some((a) => a.name === 'kicked'), 2000);
    expect(await hostedStatus('kicked')).toBe('pending');
  });

  it('does not touch hosted servers when no hosted deps are given', async () => {
    const d = deps();
    await insertHosted(db.pool, db.kek, db.owner, 'ignored');
    const p = make(d, { tickMs: 20 });
    await p.start();
    await sleep(120);
    expect(kube.applied).toEqual([]);
  });

  it('keeps ticking when a hosted pass throws', async () => {
    const d = deps();
    const bad = hostedDeps(d);
    bad.pool = {
      query: async () => {
        throw new Error('db down');
      },
    } as unknown as HostedDeps['pool'];
    const id = await add('survivor');
    const p = make(d, { tickMs: 20, hosted: bad });
    await p.start();
    await waitFor(async () => (await status(id)) === 'ready');
  });
});
