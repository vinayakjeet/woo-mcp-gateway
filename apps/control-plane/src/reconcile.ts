import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptSecret, errorCode } from '@woo/core';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { notify, withTx } from './db.js';
import { HelmError, type Helm } from './helm.js';
import { KubeError, type Kube } from './kube.js';
import type { StoreProbe } from './store-probe.js';
import {
  storeLabels,
  storeMcpUrl,
  storeUrl,
  storeValues,
  type StoreDefaults,
} from './store-values.js';

export const MAX_ATTEMPTS = 3;
export const INSTALL_TIMEOUT_SEC = 600;
export const UNINSTALL_TIMEOUT_SEC = 300;
// 30 tries 2 s apart: the site is installed by the time helm returns, this only covers a slow pod.
export const VERIFY_ATTEMPTS = 30;
export const VERIFY_INTERVAL_MS = 2000;

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
  probe: StoreProbe;
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
    if (r.rows[0]) await notify(c, 'stores_changed', job.id);
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
    if (!r.rows[0]) return;
    const m = await c.query<{ id: string }>(
      'update mcp_servers set enabled = true, updated_at = now() where store_id = $1 returning id',
      [job.id],
    );
    for (const s of m.rows) await notify(c, 'registry_changed', s.id);
    await notify(c, 'stores_changed', job.id);
  });
  d.log.info({ store: job.slug }, 'store ready');
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

// Helm returning means the release is ready and its bootstrap hook Job completed. That does not
// prove the store works, so one real get_info call does. A store is usable only after it answers.
async function verifyStore(d: ReconcileDeps, job: StoreJob, signal?: AbortSignal): Promise<void> {
  const token = await storeToken(d, job);
  const url = storeMcpUrl(job.slug);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = '';
  for (let i = 1; i <= VERIFY_ATTEMPTS; i++) {
    try {
      await d.probe(url, token, signal);
      return;
    } catch (err) {
      if (signal?.aborted) throw err;
      last = (err instanceof Error ? err.message : String(err)).split(token).join('***');
    }
    if (i < VERIFY_ATTEMPTS) await sleep(VERIFY_INTERVAL_MS);
  }
  throw new ReconcileError(
    `get_info did not answer after ${VERIFY_ATTEMPTS} tries: ${last.slice(0, 200)}`,
  );
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
  try {
    await setStep(d, job, 'namespace');
    await d.kube.applyNamespace(job.namespace, storeLabels(job.slug));
    await setStep(d, job, 'helm-status');
    const st = await d.helm.status(job.release, job.namespace, signal);
    if (st === 'failed') {
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
      await withValuesFile(d.workDir, storeValues(d.defaults, job, token), (valuesFile) =>
        d.helm.upgradeInstall({
          release: job.release,
          ns: job.namespace,
          chart: d.chartPath,
          valuesFile,
          timeoutSec: INSTALL_TIMEOUT_SEC,
          redact: [token],
          signal,
        }),
      );
    }
    await setStep(d, job, 'verify');
    await verifyStore(d, job, signal);
    await setStep(d, job, 'register');
    await markReady(d, job);
  } catch (err) {
    const detail = failureDetail(err);
    await setReason(d, job, `Step ${job.lastStep} failed on attempt ${job.attempt + 1}: ${detail}`);
    d.log.warn({ store: job.slug, step: job.lastStep, detail }, 'store step failed');
  }
}
