import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { reconcileHosted, type HostedDeps } from './hosted-reconcile.js';
import { KubeError } from './kube.js';
import { listen } from './test-app.js';
import type { Log } from './reconcile.js';
import { FakeKube, TEST_HOSTED_CONFIG, insertHosted, storeDb } from './test-stores.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('reconcileHosted (needs TEST_DATABASE_URL)', () => {
  let db: Awaited<ReturnType<typeof storeDb>>;
  const lines: string[] = [];
  const spy: Log = {
    info: (...a: unknown[]) => void lines.push(JSON.stringify(a)),
    warn: (...a: unknown[]) => void lines.push(JSON.stringify(a)),
    error: (...a: unknown[]) => void lines.push(JSON.stringify(a)),
  };

  beforeAll(async () => {
    db = await storeDb('woo_hosted_reconcile_test');
  }, 30_000);
  // Every pass walks all hosted rows, so one test's rows must not reach the next test.
  afterEach(async () => {
    await db.pool.query('delete from hosted_servers');
    await db.pool.query("delete from mcp_servers where kind = 'hosted'");
  });
  afterAll(async () => {
    await db.pool.end();
  });

  const setup = () => {
    const kube = new FakeKube();
    const d: HostedDeps = {
      pool: db.pool,
      kek: db.kek,
      kube,
      config: TEST_HOSTED_CONFIG,
      log: spy,
    };
    return { kube, d, pass: () => reconcileHosted(d, new AbortController().signal) };
  };
  const add = (slug: string, over = {}) => insertHosted(db.pool, db.kek, db.owner, slug, over);
  const row = async (slug: string) =>
    (
      await db.pool.query(
        `select h.status, h.status_reason as reason, s.enabled
         from hosted_servers h left join mcp_servers s on s.id = h.server_id where h.slug = $1`,
        [slug],
      )
    ).rows[0];
  const exists = async (slug: string) =>
    (await db.pool.query('select 1 from hosted_servers where slug = $1', [slug])).rowCount === 1;

  it('applies Secret, NetworkPolicy, Service, Deployment in that order with field manager platform', async () => {
    const { kube, pass } = setup();
    await add('ord');
    await pass();
    expect(kube.applied).toEqual([
      { kind: 'Secret', name: 'ord-env', fieldManager: 'platform' },
      { kind: 'NetworkPolicy', name: 'ord', fieldManager: 'platform' },
      { kind: 'Service', name: 'ord', fieldManager: 'platform' },
      { kind: 'Deployment', name: 'ord', fieldManager: 'platform' },
    ]);
    // The decrypted values reach the Secret and the token is the one the gateway sends.
    const secret = kube.objects.get('Secret/mcp-hosted/ord-env') as {
      data: Record<string, string>;
    };
    const dec = (k: string) => Buffer.from(secret.data[k]!, 'base64').toString('utf8');
    expect(dec('DEMO_SECRET')).toBe('sec-ord');
    expect(dec('MCP_SHARED_TOKEN')).toBe('tok-ord');
    expect(await row('ord')).toMatchObject({ status: 'pending', enabled: false });
  });

  it('sets ready, enables the server row and notifies once the Deployment is available', async () => {
    const { kube, pass } = setup();
    const { serverId } = await add('up');
    await pass();
    expect(await row('up')).toMatchObject({ status: 'pending', enabled: false });
    kube.deployments.set('up', { available: true, deadlineExceeded: false });
    const reg = await listen(db.url, 'registry_changed');
    const hos = await listen(db.url, 'hosted_changed');
    try {
      await pass();
      expect(await row('up')).toMatchObject({ status: 'ready', reason: null, enabled: true });
      expect(await reg.waitFor(1)).toEqual([serverId]);
      expect((await hos.waitFor(1)).length).toBe(1);
    } finally {
      await reg.close();
      await hos.close();
    }
  });

  it('keeps the server row disabled while the Deployment is not available', async () => {
    const { pass } = setup();
    await add('wait');
    await pass();
    await pass();
    await pass();
    expect(await row('wait')).toMatchObject({ status: 'pending', enabled: false });
  });

  it('records the pod waiting reason as the pending reason', async () => {
    const { kube, pass } = setup();
    await add('pull');
    kube.waiting.set('pull', ['ImagePullBackOff']);
    await pass();
    expect(await row('pull')).toMatchObject({ status: 'pending', reason: 'ImagePullBackOff' });
    kube.waiting.set('pull', ['CrashLoopBackOff']);
    await pass();
    expect((await row('pull')).reason).toBe('CrashLoopBackOff');
  });

  it('sets failed on ProgressDeadlineExceeded and stops re-applying', async () => {
    const { kube, pass } = setup();
    await add('late');
    await pass();
    kube.deployments.set('late', { available: false, deadlineExceeded: true });
    kube.waiting.set('late', ['ImagePullBackOff']);
    await pass();
    expect(await row('late')).toMatchObject({
      status: 'failed',
      reason: 'ProgressDeadlineExceeded: ImagePullBackOff',
    });
    const calls = kube.calls.length;
    kube.objects.clear();
    await pass();
    await pass();
    expect(kube.calls.length).toBe(calls);
    expect(kube.objects.size).toBe(0);
  });

  it('sets failed on an apply 422 with the status and reason only', async () => {
    const { kube, pass } = setup();
    await add('bad422');
    kube.hostedApplyError = new KubeError(422, 'Invalid');
    await pass();
    expect(await row('bad422')).toMatchObject({
      status: 'failed',
      reason: 'Apply failed: Kubernetes API answered 422 Invalid',
    });
    kube.hostedApplyError = null;
    await pass();
    expect(kube.applied).toEqual([]);
  });

  it('stays pending on an apply 500 or a timeout and retries on the next pass', async () => {
    const { kube, pass } = setup();
    await add('flaky');
    kube.hostedApplyError = new KubeError(500, 'InternalError');
    await pass();
    expect(await row('flaky')).toMatchObject({
      status: 'pending',
      reason: 'Apply failed: Kubernetes API answered 500 InternalError',
    });
    kube.hostedApplyError = new Error('Kubernetes API timed out');
    await pass();
    expect((await row('flaky')).status).toBe('pending');
    expect(kube.applied).toEqual([]);
    kube.hostedApplyError = null;
    await pass();
    expect(kube.applied.map((a) => a.kind)).toEqual([
      'Secret',
      'NetworkPolicy',
      'Service',
      'Deployment',
    ]);
    expect((await row('flaky')).reason).toBe('Waiting for the Deployment');
  });

  it('sends a ready server back to pending when the Deployment becomes unavailable, row still enabled', async () => {
    const { kube, pass } = setup();
    await add('blip');
    await pass();
    kube.deployments.set('blip', { available: true, deadlineExceeded: false });
    await pass();
    expect(await row('blip')).toMatchObject({ status: 'ready', enabled: true });
    kube.deployments.set('blip', { available: false, deadlineExceeded: false });
    kube.waiting.set('blip', ['CrashLoopBackOff']);
    await pass();
    expect(await row('blip')).toMatchObject({
      status: 'pending',
      reason: 'CrashLoopBackOff',
      enabled: true,
    });
    kube.deployments.set('blip', { available: true, deadlineExceeded: false });
    await pass();
    expect(await row('blip')).toMatchObject({ status: 'ready', reason: null, enabled: true });
  });

  it('applies again when the Deployment was deleted behind our back', async () => {
    const { kube, pass } = setup();
    await add('gone');
    await pass();
    kube.deployments.set('gone', { available: true, deadlineExceeded: false });
    await pass();
    expect((await row('gone')).status).toBe('ready');
    kube.applied.length = 0;
    kube.objects.delete('Deployment/mcp-hosted/gone');
    await pass();
    expect(kube.applied.map((a) => a.kind)).toEqual([
      'Secret',
      'NetworkPolicy',
      'Service',
      'Deployment',
    ]);
    expect((await row('gone')).enabled).toBe(true);
  });

  it('does not touch a failed row', async () => {
    const { kube, pass } = setup();
    await add('dead', { status: 'failed' });
    await pass();
    expect(kube.calls).toEqual([]);
    expect((await row('dead')).status).toBe('failed');
  });

  describe('apply-time checks', () => {
    it('fails a row whose image is outside the allowlist and applies nothing', async () => {
      const { kube, pass } = setup();
      await add('evil', { image: 'busybox:1.37' });
      await pass();
      expect(kube.applied).toEqual([]);
      const r = await row('evil');
      expect(r.status).toBe('failed');
      expect(r.reason).toMatch(/^Invalid spec: image: /);
      expect(r.reason).not.toContain('sec-evil');
    });

    it('fails a row whose image is latest', async () => {
      const { kube, pass } = setup();
      await add('lat', { image: 'fx-mcp:latest' });
      await pass();
      expect(kube.applied).toEqual([]);
      expect((await row('lat')).status).toBe('failed');
    });

    it('fails a row whose secret env cannot be decrypted', async () => {
      const { kube, pass } = setup();
      await add('tamper');
      await db.pool.query(
        `update hosted_servers set secret_env_enc = (select auth_secret_enc from mcp_servers where slug = 'tamper')
         where slug = 'tamper'`,
      );
      await pass();
      expect(kube.applied).toEqual([]);
      expect(await row('tamper')).toMatchObject({
        status: 'failed',
        reason: 'Secret env could not be decrypted',
      });
    });
  });

  it('does not overwrite a row that moved to deleting during the pass', async () => {
    const { kube, pass } = setup();
    const { serverId } = await add('race');
    const apply = kube.apply.bind(kube);
    kube.apply = async (o, fm) => {
      await apply(o, fm);
      if (o.kind === 'Deployment') {
        await db.pool.query(`update hosted_servers set status = 'deleting' where slug = 'race'`);
      }
    };
    kube.deployments.set('race', { available: true, deadlineExceeded: false });
    await pass();
    expect((await row('race')).status).toBe('deleting');
    expect(
      (await db.pool.query('select enabled from mcp_servers where id = $1', [serverId])).rows[0]
        .enabled,
    ).toBe(false);
  });

  describe('delete', () => {
    it('deletes every labeled object, waits for the pods, then deletes the row', async () => {
      const { kube, pass } = setup();
      await add('del');
      await pass();
      expect(kube.objects.size).toBe(4);
      await db.pool.query(`update hosted_servers set status = 'deleting' where slug = 'del'`);
      kube.podLingerPolls = 2;
      await pass();
      expect(kube.objects.size).toBe(0);
      expect(await row('del')).toMatchObject({
        status: 'deleting',
        reason: 'Waiting for pods to stop',
      });
      await pass();
      expect(await exists('del')).toBe(true);
      await pass();
      expect(await exists('del')).toBe(false);
      expect(kube.calls.filter((c) => c.startsWith('delete ')).sort()).toEqual([
        'delete Deployment/del',
        'delete NetworkPolicy/del',
        'delete Secret/del-env',
        'delete Service/del',
      ]);
    });

    it('deletes the row at once when nothing is left in the cluster', async () => {
      const { pass } = setup();
      await add('clean', { status: 'deleting' });
      await pass();
      expect(await exists('clean')).toBe(false);
    });

    it('finishes a delete that a restart interrupted with half the objects gone', async () => {
      const { kube, pass } = setup();
      await add('half');
      await pass();
      kube.objects.delete('Deployment/mcp-hosted/half');
      kube.objects.delete('Service/mcp-hosted/half');
      await db.pool.query(`update hosted_servers set status = 'deleting' where slug = 'half'`);
      await pass();
      expect(kube.objects.size).toBe(0);
      expect(await exists('half')).toBe(false);
    });

    it('keeps the row and retries when a delete fails', async () => {
      const { kube, pass } = setup();
      await add('stuck');
      await pass();
      await db.pool.query(`update hosted_servers set status = 'deleting' where slug = 'stuck'`);
      const del = kube.deleteObject.bind(kube);
      kube.deleteObject = async () => {
        throw new KubeError(500, 'InternalError');
      };
      await pass();
      expect(await exists('stuck')).toBe(true);
      expect((await row('stuck')).reason).toBe(
        'Delete failed: Kubernetes API answered 500 InternalError',
      );
      kube.deleteObject = del;
      await pass();
      expect(await exists('stuck')).toBe(false);
    });

    it('leaves audit rows alone', async () => {
      const { pass } = setup();
      await add('aud', { status: 'deleting' });
      await db.pool.query(
        `insert into audit_events (request_id, user_id, user_email, via, server_slug, tool_name,
           exposed_name, outcome, duration_ms, replica)
         values (gen_random_uuid(), $1, 'admin@example.com', 'api_key', 'aud', 'get_info',
           'aud__get_info', 'ok', 5, 'test')`,
        [db.owner],
      );
      await pass();
      expect(await exists('aud')).toBe(false);
      expect(
        (await db.pool.query(`select 1 from audit_events where server_slug = 'aud'`)).rowCount,
      ).toBe(1);
    });
  });

  it('stops between rows when the signal is aborted', async () => {
    const { kube, d } = setup();
    await add('ab1');
    await add('ab2');
    const ac = new AbortController();
    ac.abort();
    await reconcileHosted(d, ac.signal);
    expect(kube.calls).toEqual([]);
  });

  it('writes no secret value, token or request body to status_reason or the log', async () => {
    const { kube, pass } = setup();
    await add('leaky');
    kube.hostedApplyError = new KubeError(422, 'Invalid');
    await pass();
    kube.hostedApplyError = new Error('boom sec-leaky tok-leaky');
    await db.pool.query(`update hosted_servers set status = 'pending' where slug = 'leaky'`);
    await pass();
    const reasons = (await db.pool.query('select status_reason from hosted_servers')).rows
      .map((r) => r.status_reason ?? '')
      .join('\n');
    const all = `${reasons}\n${lines.join('\n')}`;
    expect(all.length).toBeGreaterThan(10);
    for (const v of ['sec-', 'tok-', Buffer.from('sec-leaky').toString('base64')]) {
      expect(all, v).not.toContain(v);
    }
  });
});
