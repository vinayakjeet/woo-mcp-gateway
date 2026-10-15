import { decryptSecret, errorCode } from '@woo/core';
import type pg from 'pg';
import { notify, withTx } from './db.js';
import { parseHostedInput, type HostedConfig } from './hosted-input.js';
import {
  HOSTED_LABEL,
  HOSTED_NAMESPACE,
  hostedManifests,
  type HostedSpec,
} from './hosted-manifests.js';
import { KubeError, type HostedKind, type Kube } from './kube.js';
import { failureDetail, type Log } from './reconcile.js';

// SPEC 21: the field manager for everything this pass applies.
export const HOSTED_FIELD_MANAGER = 'platform';
// The Deployment goes first so its pods start to stop, and the Secret goes last.
const DELETE_ORDER: HostedKind[] = ['Deployment', 'Service', 'NetworkPolicy', 'Secret'];
const MAX_REASON = 300;

export type HostedDeps = {
  pool: pg.Pool;
  kek: Buffer;
  kube: Kube;
  config: HostedConfig;
  log: Log;
};

type Job = {
  id: string;
  slug: string;
  image: string;
  port: number;
  path: string;
  env: { plain?: { name: string; value: string }[] } | null;
  cpu: string;
  memory: string;
  status: 'pending' | 'ready' | 'deleting';
  reason: string | null;
  serverId: string | null;
};

const JOB_SELECT = `select id, slug, image, port, path, env, cpu_limit as cpu, memory_limit as memory,
    status, status_reason as reason, server_id as "serverId"
  from hosted_servers where status in ('pending', 'ready', 'deleting') order by created_at`;

// One pass over every hosted row, run by the provisioner leader. State lives only in Postgres and
// in the labeled objects, so a pass that a restart cut short is simply run again. It sleeps
// nowhere: a delete that is waiting for pods returns and the next tick looks again.
export async function reconcileHosted(d: HostedDeps, signal: AbortSignal): Promise<void> {
  const { rows } = await d.pool.query<Job>(JOB_SELECT);
  for (const job of rows) {
    if (signal.aborted) return;
    try {
      if (job.status === 'deleting') await teardown(d, job);
      else await reconcileOne(d, job);
    } catch (err) {
      d.log.warn({ slug: job.slug, code: errorCode(err) }, 'hosted reconcile failed');
    }
  }
}

async function reconcileOne(d: HostedDeps, job: Job): Promise<void> {
  const selector = `${HOSTED_LABEL}=${job.slug}`;
  let st = await d.kube.deploymentStatus(HOSTED_NAMESPACE, job.slug);
  if (!st.exists) {
    // Missing at first create, after a failed apply, or deleted behind our back.
    if (!(await applyAll(d, job))) return;
    st = await d.kube.deploymentStatus(HOSTED_NAMESPACE, job.slug);
  }
  if (st.deadlineExceeded) {
    const waiting = await d.kube.podWaitingReasons(HOSTED_NAMESPACE, selector);
    const why = waiting[0] ? `: ${waiting[0]}` : '';
    await setStatus(d, job, 'failed', `ProgressDeadlineExceeded${why}`);
    return;
  }
  if (st.available) {
    if (job.status === 'ready') return;
    await markReady(d, job);
    return;
  }
  const waiting = await d.kube.podWaitingReasons(HOSTED_NAMESPACE, selector);
  await setStatus(d, job, 'pending', waiting[0] ?? 'Waiting for the Deployment');
}

// True when the objects were applied and the caller should read the status next.
async function applyAll(d: HostedDeps, job: Job): Promise<boolean> {
  const spec: HostedSpec = {
    slug: job.slug,
    image: job.image,
    port: job.port,
    path: job.path,
    env: job.env?.plain ?? [],
    cpu: job.cpu,
    memory: job.memory,
  };
  // Checked again here, against today's config: a row written around the API, or an allowlist
  // that has shrunk since the row was made, must not reach the cluster. A retry cannot fix it.
  const check = parseHostedInput(d.config, { ...spec, secretEnv: [] });
  if (!check.ok) {
    const why = check.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    await setStatus(d, job, 'failed', `Invalid spec: ${why}`);
    return false;
  }
  const secrets = await loadSecrets(d, job);
  if (!secrets) {
    await setStatus(d, job, 'failed', 'Secret env could not be decrypted');
    return false;
  }
  const m = hostedManifests(spec, secrets, d.config);
  try {
    // The policy goes before the Deployment, so the pod never starts without it.
    for (const obj of [m.secret, m.networkPolicy, m.service, m.deployment]) {
      await d.kube.apply(obj, HOSTED_FIELD_MANAGER);
    }
  } catch (err) {
    const reason = `Apply failed: ${failureDetail(err)}`;
    // 400 and 422 mean the API server refused the objects, which a retry cannot change.
    const final = err instanceof KubeError && (err.status === 400 || err.status === 422);
    await setStatus(d, job, final ? 'failed' : 'pending', reason);
    return false;
  }
  return true;
}

// The only place the control-plane decrypts a hosted secret (decision 20). The values go from
// here into the Secret object and nowhere else.
async function loadSecrets(d: HostedDeps, job: Job): Promise<Record<string, string> | null> {
  const r = await d.pool.query<{ enc: Buffer | null }>(
    'select secret_env_enc as enc from hosted_servers where id = $1',
    [job.id],
  );
  const enc = r.rows[0]?.enc;
  if (!enc) return {};
  try {
    const parsed: unknown = JSON.parse(decryptSecret(enc, d.kek, `hosted:${job.slug}`));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (!entries.every(([, v]) => typeof v === 'string')) return null;
    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    return null;
  }
}

// Every write names the status the pass read, so a row that moved on, such as one an admin just
// deleted, is never overwritten.
async function setStatus(
  d: HostedDeps,
  job: Job,
  status: 'pending' | 'failed',
  reason: string,
): Promise<void> {
  const text = reason.slice(0, MAX_REASON);
  if (job.status === status && job.reason === text) return;
  const changed = job.status !== status;
  const r = await d.pool.query(
    'update hosted_servers set status = $3, status_reason = $4 where id = $1 and status = $2',
    [job.id, job.status, status, text],
  );
  if (r.rowCount === 0) return;
  job.status = status as Job['status'];
  job.reason = text;
  if (changed) await withTx(d.pool, (c) => notify(c, 'hosted_changed', job.id));
  d.log.info({ slug: job.slug, status }, 'hosted server status');
}

async function markReady(d: HostedDeps, job: Job): Promise<void> {
  const moved = await withTx(d.pool, async (c) => {
    const u = await c.query(
      `update hosted_servers set status = 'ready', status_reason = null
       where id = $1 and status = $2`,
      [job.id, job.status],
    );
    if (u.rowCount === 0) return false;
    // The server row is enabled only here, so the gateway never lists tools of a pod that is not up.
    if (job.serverId) {
      const s = await c.query<{ id: string }>(
        'update mcp_servers set enabled = true, updated_at = now() where id = $1 returning id',
        [job.serverId],
      );
      for (const row of s.rows) await notify(c, 'registry_changed', row.id);
    }
    await notify(c, 'hosted_changed', job.id);
    return true;
  });
  if (moved) d.log.info({ slug: job.slug, status: 'ready' }, 'hosted server status');
}

async function teardown(d: HostedDeps, job: Job): Promise<void> {
  const selector = `${HOSTED_LABEL}=${job.slug}`;
  let waiting: boolean;
  try {
    for (const kind of DELETE_ORDER) {
      for (const name of await d.kube.listNames(kind, HOSTED_NAMESPACE, selector)) {
        await d.kube.deleteObject(kind, HOSTED_NAMESPACE, name);
      }
    }
    waiting = (await d.kube.listNames('Pod', HOSTED_NAMESPACE, selector)).length > 0;
  } catch (err) {
    await setDeleteReason(d, job, `Delete failed: ${failureDetail(err)}`);
    return;
  }
  if (waiting) {
    await setDeleteReason(d, job, 'Waiting for pods to stop');
    return;
  }
  await d.pool.query("delete from hosted_servers where id = $1 and status = 'deleting'", [job.id]);
  d.log.info({ slug: job.slug }, 'hosted server deleted');
}

async function setDeleteReason(d: HostedDeps, job: Job, reason: string): Promise<void> {
  if (job.reason === reason) return;
  job.reason = reason;
  await d.pool.query(
    "update hosted_servers set status_reason = $2 where id = $1 and status = 'deleting'",
    [job.id, reason],
  );
}
