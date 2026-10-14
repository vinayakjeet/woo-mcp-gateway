import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptSecret, errorCode } from '@woo/core';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { notify, withTx } from './db.js';
import { HelmError, type Helm, type ReleaseStatus } from './helm.js';
import { KubeError, type Kube } from './kube.js';
import { DEADLINE_MINUTES } from './store-input.js';
import { storeLabels, storeUrl, storeValues, type StoreDefaults } from './store-values.js';

export const MAX_ATTEMPTS = 3;
export const INSTALL_TIMEOUT_SEC = 600;
export const UNINSTALL_TIMEOUT_SEC = 300;
export const VERIFY_INTERVAL_MS = 2000;
const DEADLINE_FALLBACK_MS = 15 * 60_000;
export const MIN_INSTALL_TIMEOUT_SEC = 30;

// A control-plane that died mid-operation leaves the release locked in one of these (SPEC 18).
const RECOVERABLE: ReadonlySet<ReleaseStatus> = new Set([
  'pending-install',
  'pending-upgrade',
  'pending-rollback',
  'uninstalling',
]);

export type Log = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export type StoreJob = {
  id: string;
  slug: string;
  name: string;
  status: 'provisioning' | 'deleting';
  attempt: number;
  lastStep: string | null;
  deadlineAt: Date | null;
  namespace: string;
  release: string;
};

export const JOB_SELECT = `select id, slug, name, status, attempt, last_step as "lastStep",
    deadline_at as "deadlineAt", namespace, release
  from stores`;

export type ReconcileDeps = {
  pool: pg.Pool;
  kek: Buffer;
  kube: Kube;
  helm: Helm;
  defaults: StoreDefaults;
  chartPath: string;
  workDir: string;
  log: Log;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  namespaceWaitMs?: number;
};

export class ReconcileError extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

// What reaches status_reason and the log: helm's cut last line, the API status and reason, our
// own text, or an error code. Other messages can carry SQL (core logging.ts).
export function failureDetail(err: unknown): string {
  if (err instanceof HelmError || err instanceof ReconcileError) return err.detail;
  if (err instanceof KubeError) return err.message;
  return `error ${errorCode(err)}`;
}

// Every write checks the status, so a pass never overwrites a row that moved on.
async function setStep(d: ReconcileDeps, job: StoreJob, step: string): Promise<void> {
  job.lastStep = step;
  await d.pool.query(
    'update stores set last_step = $3, updated_at = now() where id = $1 and status = $2',
    [job.id, job.status, step],
  );
}

async function setReason(d: ReconcileDeps, job: StoreJob, reason: string): Promise<void> {
  await d.pool.query(
    'update stores set status_reason = $3, updated_at = now() where id = $1 and status = $2',
    [job.id, job.status, reason],
  );
}

async function markFailed(
  d: ReconcileDeps,
  job: StoreJob,
  reason: string,
  attempt: number,
): Promise<void> {
  await withTx(d.pool, async (c) => {
    const r = await c.query(
      `update stores set status = 'failed', status_reason = $2, attempt = $3, updated_at = now()
       where id = $1 and status = 'provisioning' returning id`,
      [job.id, reason, attempt],
    );
    if (!r.rows[0]) return;
    // A failed store must not stay routable.
    const m = await c.query<{ id: string }>(
      'update mcp_servers set enabled = false, updated_at = now() where store_id = $1 and enabled returning id',
      [job.id],
    );
    for (const s of m.rows) await notify(c, 'registry_changed', s.id);
    await notify(c, 'stores_changed', job.id);
  });
  d.log.warn({ store: job.slug, reason }, 'store failed');
}

async function markReady(d: ReconcileDeps, job: StoreJob): Promise<void> {
  await withTx(d.pool, async (c) => {
    const r = await c.query(
      `update stores set status = 'ready', url = $2, ready_at = now(), last_step = 'ready',
         updated_at = now()
       where id = $1 and status = 'provisioning' returning id`,
      [job.id, storeUrl(d.defaults, job.slug)],
    );
    if (r.rows[0]) await notify(c, 'stores_changed', job.id);
  });
  d.log.info({ store: job.slug }, 'store ready');
}

// The gateway loads the server on registry_changed, so a store is routable from here on.
async function enableServer(d: ReconcileDeps, job: StoreJob): Promise<void> {
  await withTx(d.pool, async (c) => {
    const m = await c.query<{ id: string }>(
      `update mcp_servers set enabled = true, updated_at = now()
       where store_id = $1
         and exists (select 1 from stores where id = $1 and status = 'provisioning')
       returning id`,
      [job.id],
    );
    for (const s of m.rows) await notify(c, 'registry_changed', s.id);
  });
}

// Helm returning proves the bootstrap hook Job ran. "Usable" is decided through the gateway, the only
// caller SPEC 16 lets reach woo-mcp: its health check must see the server connected. Returns the
// failure reason once the store deadline passes, or null when the server is connected.
async function waitForGateway(
  d: ReconcileDeps,
  job: StoreJob,
  signal?: AbortSignal,
): Promise<string | null> {
  const now = d.now ?? (() => new Date());
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const limit = job.deadlineAt ?? new Date(now().getTime() + DEADLINE_FALLBACK_MS);
  for (;;) {
    const r = await d.pool.query<{
      state: string | null;
      kind: string | null;
      message: string | null;
    }>(
      `select s.state, s.error_kind as kind, s.error_message as message
       from mcp_servers m left join mcp_server_status s on s.server_id = m.id
       where m.store_id = $1`,
      [job.id],
    );
    const st = r.rows[0];
    if (st?.state === 'connected') return null;
    if (now() >= limit) {
      if (!st?.kind) return 'The gateway did not report on the store before its deadline';
      const detail = st.message ? `${st.kind}: ${st.message}` : st.kind;
      return `The gateway could not connect to the store: ${detail}`.slice(0, 300);
    }
    signal?.throwIfAborted();
    await sleep(VERIFY_INTERVAL_MS);
  }
}

async function storeToken(d: ReconcileDeps, job: StoreJob): Promise<string> {
  const r = await d.pool.query<{ slug: string; enc: Buffer | null }>(
    'select slug, auth_secret_enc as enc from mcp_servers where store_id = $1',
    [job.id],
  );
  const row = r.rows[0];
  if (!row?.enc) throw new ReconcileError('the store has no MCP server credential');
  return decryptSecret(row.enc, d.kek, row.slug);
}

// SPEC 18: the values file lives in the emptyDir (/tmp) only while helm runs.
async function withValuesFile<T>(
  dir: string,
  content: string,
  fn: (file: string) => Promise<T>,
): Promise<T> {
  const tmp = await mkdtemp(join(dir, 'store-values-'));
  try {
    const file = join(tmp, 'values.yaml');
    await writeFile(file, content, { mode: 0o600 });
    return await fn(file);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function provisionStore(
  d: ReconcileDeps,
  job: StoreJob,
  signal?: AbortSignal,
): Promise<void> {
  const clock = () => (d.now ?? (() => new Date()))().getTime();
  // SPEC 18 step 1. Resources stay for inspection; the owner can delete the failed store.
  if (job.deadlineAt && clock() >= job.deadlineAt.getTime()) {
    await markFailed(
      d,
      job,
      `Timed out after ${DEADLINE_MINUTES} min at step ${job.lastStep ?? 'queued'}`,
      job.attempt,
    );
    return;
  }
  try {
    await setStep(d, job, 'namespace');
    await d.kube.applyNamespace(job.namespace, storeLabels(job.slug));
    await setStep(d, job, 'helm-status');
    const st = await d.helm.status(job.release, job.namespace, signal);
    if (RECOVERABLE.has(st)) {
      await setStep(d, job, 'recover');
      await d.helm.uninstall(job.release, job.namespace, UNINSTALL_TIMEOUT_SEC, signal);
      await setReason(d, job, `Recovered from ${st} left by an earlier run`);
    } else if (st === 'failed') {
      const attempt = job.attempt + 1;
      if (attempt >= MAX_ATTEMPTS) {
        await markFailed(
          d,
          job,
          `Install failed ${attempt} times. The last release is kept for inspection.`,
          attempt,
        );
        return;
      }
      await setStep(d, job, 'uninstall-failed');
      await d.helm.uninstall(job.release, job.namespace, UNINSTALL_TIMEOUT_SEC, signal);
      await d.pool.query(
        "update stores set attempt = $2 where id = $1 and status = 'provisioning'",
        [job.id, attempt],
      );
      job.attempt = attempt;
    } else if (st !== 'absent' && st !== 'deployed') {
      throw new ReconcileError(`release is ${st}`);
    }
    if (st !== 'deployed') {
      await setStep(d, job, 'install');
      const token = await storeToken(d, job);
      // Capped by the deadline, so an install started late cannot outlive it by 10 minutes.
      const left = job.deadlineAt
        ? Math.floor((job.deadlineAt.getTime() - clock()) / 1000)
        : INSTALL_TIMEOUT_SEC;
      const timeoutSec = Math.max(MIN_INSTALL_TIMEOUT_SEC, Math.min(INSTALL_TIMEOUT_SEC, left));
      await withValuesFile(d.workDir, storeValues(d.defaults, job, token), (valuesFile) =>
        d.helm.upgradeInstall({
          release: job.release,
          ns: job.namespace,
          chart: d.chartPath,
          valuesFile,
          timeoutSec,
          redact: [token],
          signal,
        }),
      );
    }
    await setStep(d, job, 'register');
    await enableServer(d, job);
    await setStep(d, job, 'verify');
    const unusable = await waitForGateway(d, job, signal);
    if (unusable) {
      await markFailed(d, job, unusable, job.attempt);
      return;
    }
    await markReady(d, job);
  } catch (err) {
    const detail = failureDetail(err);
    await setReason(d, job, `Step ${job.lastStep} failed on attempt ${job.attempt + 1}: ${detail}`);
    d.log.warn({ store: job.slug, step: job.lastStep, detail }, 'store step failed');
  }
}

export const NAMESPACE_WAIT_MS = 300_000;

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitGone(d: ReconcileDeps, ns: string): Promise<boolean> {
  const poll = d.pollMs ?? 2000;
  const polls = Math.ceil((d.namespaceWaitMs ?? NAMESPACE_WAIT_MS) / poll);
  for (let i = 0; i < polls; i++) {
    if (!(await d.kube.namespaceExists(ns))) return true;
    await (d.sleep ?? pause)(poll);
  }
  return !(await d.kube.namespaceExists(ns));
}

// SPEC 18 delete, steps 2 and 3. The API already removed the server row (step 1). The 15 minute
// deadline belongs to provisioning only: deadline_at keeps its creation value on a deleting row,
// so nothing here may read it.
export async function teardownStore(
  d: ReconcileDeps,
  job: StoreJob,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await setStep(d, job, 'uninstall');
    await d.helm.uninstall(job.release, job.namespace, UNINSTALL_TIMEOUT_SEC, signal);
    await setStep(d, job, 'namespace-delete');
    await d.kube.deleteNamespace(job.namespace);
    await setStep(d, job, 'namespace-wait');
    // The namespace takes its PVCs with it; local-path volumes use reclaimPolicy Delete.
    if (!(await waitGone(d, job.namespace))) {
      await setReason(d, job, `Namespace ${job.namespace} still exists after 5 min. Retrying.`);
      return;
    }
    await withTx(d.pool, async (c) => {
      const r = await c.query(
        "delete from stores where id = $1 and status = 'deleting' returning id",
        [job.id],
      );
      if (r.rows[0]) await notify(c, 'stores_changed', job.id);
    });
    d.log.info({ store: job.slug }, 'store deleted');
  } catch (err) {
    const detail = failureDetail(err);
    await setReason(d, job, `Step ${job.lastStep} failed: ${detail}`);
    d.log.warn({ store: job.slug, step: job.lastStep, detail }, 'store teardown step failed');
  }
}
