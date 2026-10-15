import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { encryptSecret } from '@woo/core';
import pg from 'pg';
import { HelmError, type Helm, type InstallOptions, type ReleaseStatus } from './helm.js';
import type { HostedObject } from './hosted-manifests.js';
import type { DeploymentState, HostedKind, Kube } from './kube.js';
import { migrateAndSeed } from './migrate-run.js';
import type { Log } from './reconcile.js';
import { parseStoreDefaults, storeMcpUrl, type StoreDefaults } from './store-values.js';
import { freshDatabase } from './test-db.js';

// What charts/platform renders into PROVISIONER_STORE_VALUES with deploy/values-local.yaml.
export const TEST_STORE_DEFAULTS_JSON = JSON.stringify({
  global: { domain: '127.0.0.1.nip.io', scheme: 'http', imageTag: 'dev' },
  images: { registry: '' },
  ingress: { className: 'traefik', tls: { enabled: false, clusterIssuer: '' } },
  storage: { className: 'local-path', mariadb: '2Gi', wordpress: '2Gi' },
  wordpress: { environmentType: 'local' },
});

export function testStoreDefaults(): StoreDefaults {
  return parseStoreDefaults(TEST_STORE_DEFAULTS_JSON);
}

export const quietLog: Log = { info: () => {}, warn: () => {}, error: () => {} };

export async function storeDb(name: string) {
  const url = await freshDatabase(process.env.TEST_DATABASE_URL!, name);
  const kek = randomBytes(32);
  await migrateAndSeed({
    databaseUrl: url,
    kek,
    adminEmail: 'admin@example.com',
    adminPassword: 'pw-admin-12345',
    seedServers: [],
  });
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  const owner = (await pool.query<{ id: string }>("select id from users where role = 'admin'"))
    .rows[0]!.id;
  return { url, kek, pool, owner };
}

// A store row and its server row as POST /api/stores leaves them; the token is tok-<slug>.
export async function insertStore(
  pool: pg.Pool,
  kek: Buffer,
  ownerId: string,
  slug: string,
  over: { status?: string; attempt?: number; deadlineAt?: Date; lastStep?: string } = {},
): Promise<string> {
  const status = over.status ?? 'provisioning';
  const r = await pool.query<{ id: string }>(
    `insert into stores (slug, name, owner_user_id, status, namespace, release, attempt,
       deadline_at, last_step)
     values ($1, $2, $3, $4, $5, $5, $6, $7, $8) returning id`,
    [
      slug,
      `Store ${slug}`,
      ownerId,
      status,
      `store-${slug}`,
      over.attempt ?? 0,
      over.deadlineAt ?? new Date(Date.now() + 15 * 60_000),
      over.lastStep ?? 'queued',
    ],
  );
  const id = r.rows[0]!.id;
  await pool.query(
    `insert into mcp_servers (slug, name, url, kind, managed, enabled, auth_type, auth_secret_enc,
       protocol_mode, store_id)
     values ($1, $2, $3, 'store', true, $4, 'bearer', $5, 'auto', $6)`,
    [
      slug,
      `Store ${slug}`,
      storeMcpUrl(slug),
      status === 'ready',
      encryptSecret(`tok-${slug}`, kek, slug),
      id,
    ],
  );
  return id;
}

export async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > end) throw new Error(`condition not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function abortable(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new HelmError('install', 'aborted'));
    signal.addEventListener('abort', () => reject(new HelmError('install', 'aborted')), {
      once: true,
    });
    p.then(resolve, reject);
  });
}

// Releases keyed "<ns>/<release>". An install is pending-install while it runs, like helm.
export class FakeHelm implements Helm {
  readonly releases = new Map<string, ReleaseStatus>();
  readonly calls: string[] = [];
  readonly values: string[] = [];
  failNext = 0;
  gate: Promise<void> | null = null;
  active = 0;
  maxActive = 0;
  aborted = 0;

  async status(release: string, ns: string): Promise<ReleaseStatus> {
    this.calls.push(`status ${ns}/${release}`);
    return this.releases.get(`${ns}/${release}`) ?? 'absent';
  }

  async upgradeInstall(o: InstallOptions): Promise<void> {
    const key = `${o.ns}/${o.release}`;
    this.calls.push(`install ${key} timeout=${o.timeoutSec}`);
    this.values.push(await readFile(o.valuesFile, 'utf8'));
    this.releases.set(key, 'pending-install');
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.gate) await abortable(this.gate, o.signal);
    } catch (err) {
      this.aborted++;
      throw err;
    } finally {
      this.active--;
    }
    if (this.failNext > 0) {
      this.failNext--;
      this.releases.set(key, 'failed');
      throw new HelmError('install', 'Error: INSTALLATION FAILED: boom');
    }
    this.releases.set(key, 'deployed');
  }

  async uninstall(release: string, ns: string): Promise<void> {
    this.calls.push(`uninstall ${ns}/${release}`);
    this.releases.delete(`${ns}/${release}`);
  }
}

export class FakeKube implements Kube {
  readonly namespaces = new Map<string, Record<string, string>>();
  readonly calls: string[] = [];
  applyError: Error | null = null;
  // How many namespaceExists calls still see a deleted namespace. Infinity never finishes.
  terminatingPolls = 0;
  private readonly deleting = new Map<string, number>();

  async applyNamespace(name: string, labels: Record<string, string>): Promise<void> {
    this.calls.push(`apply ${name}`);
    if (this.applyError) throw this.applyError;
    this.namespaces.set(name, labels);
  }

  async namespaceExists(name: string): Promise<boolean> {
    this.calls.push(`get ${name}`);
    const left = this.deleting.get(name);
    if (left === undefined) return this.namespaces.has(name);
    if (left > 0) {
      this.deleting.set(name, left - 1);
      return true;
    }
    this.deleting.delete(name);
    this.namespaces.delete(name);
    return false;
  }

  async deleteNamespace(name: string): Promise<void> {
    this.calls.push(`delete ${name}`);
    if (this.namespaces.has(name) && !this.deleting.has(name)) {
      this.deleting.set(name, this.terminatingPolls);
    }
  }

  // Hosted objects, keyed kind/namespace/name. Pods are implied: one exists while its Deployment
  // does, and for podLingerPolls more listNames('Pod') calls after the Deployment is deleted.
  readonly objects = new Map<string, HostedObject>();
  readonly applied: { kind: string; name: string; fieldManager: string }[] = [];
  hostedApplyError: Error | null = null;
  readonly deployments = new Map<string, Omit<DeploymentState, 'exists'>>();
  readonly waiting = new Map<string, string[]>();
  podLingerPolls = 0;
  private readonly lingering = new Map<string, number>();

  async apply(obj: HostedObject, fieldManager: string): Promise<void> {
    this.calls.push(`apply ${obj.kind}/${obj.metadata.name}`);
    if (this.hostedApplyError) throw this.hostedApplyError;
    this.applied.push({ kind: obj.kind, name: obj.metadata.name, fieldManager });
    this.objects.set(`${obj.kind}/${obj.metadata.namespace}/${obj.metadata.name}`, obj);
  }

  async deploymentStatus(ns: string, name: string): Promise<DeploymentState> {
    this.calls.push(`status ${name}`);
    if (!this.objects.has(`Deployment/${ns}/${name}`)) {
      return { exists: false, available: false, deadlineExceeded: false };
    }
    return {
      exists: true,
      available: false,
      deadlineExceeded: false,
      ...this.deployments.get(name),
    };
  }

  async podWaitingReasons(_ns: string, selector: string): Promise<string[]> {
    return this.waiting.get(selector.split('=')[1] ?? '') ?? [];
  }

  async listNames(kind: HostedKind | 'Pod', ns: string, selector: string): Promise<string[]> {
    const slug = selector.split('=')[1] ?? '';
    if (kind === 'Pod') {
      const left = this.lingering.get(slug) ?? 0;
      if (left > 0) {
        this.lingering.set(slug, left - 1);
        return [`${slug}-pod`];
      }
      return this.objects.has(`Deployment/${ns}/${slug}`) ? [`${slug}-pod`] : [];
    }
    return [...this.objects.values()]
      .filter((o) => o.kind === kind && o.metadata.namespace === ns)
      .filter((o) => o.metadata.labels['urumi.io/hosted'] === slug)
      .map((o) => o.metadata.name);
  }

  async deleteObject(kind: HostedKind, ns: string, name: string): Promise<void> {
    this.calls.push(`delete ${kind}/${name}`);
    this.objects.delete(`${kind}/${ns}/${name}`);
    if (kind === 'Deployment') this.lingering.set(name, this.podLingerPolls);
  }
}

// Stands in for the gateway's status writer: the state it reports for a store's MCP server.
export async function reportStatus(
  pool: pg.Pool,
  storeId: string,
  state: 'connected' | 'unreachable',
  kind: string | null = null,
  message: string | null = null,
): Promise<void> {
  await pool.query(
    `insert into mcp_server_status (server_id, state, error_kind, error_message, checked_at)
     select id, $2::server_state, $3, $4, now() from mcp_servers where store_id = $1
     on conflict (server_id) do update set state = excluded.state,
       error_kind = excluded.error_kind, error_message = excluded.error_message, checked_at = now()`,
    [storeId, state, kind, message],
  );
}

// What the gateway does for every enabled store server once it has loaded and reached it.
export async function connectAll(pool: pg.Pool): Promise<void> {
  await pool.query(
    `insert into mcp_server_status (server_id, state, checked_at)
     select id, 'connected', now() from mcp_servers where store_id is not null and enabled
     on conflict (server_id) do update set state = 'connected', error_kind = null,
       error_message = null`,
  );
}
