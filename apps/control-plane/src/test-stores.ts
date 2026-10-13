import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { encryptSecret } from '@woo/core';
import pg from 'pg';
import { HelmError, type Helm, type InstallOptions, type ReleaseStatus } from './helm.js';
import type { Kube } from './kube.js';
import { migrateAndSeed } from './migrate-run.js';
import type { Log } from './reconcile.js';
import type { StoreProbe } from './store-probe.js';
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
}

export class FakeProbe {
  readonly calls: Array<{ url: string; token: string }> = [];
  failTimes = 0;
  failWith = 'connection refused';
  onCall: (() => Promise<void>) | null = null;

  readonly fn: StoreProbe = async (url, token) => {
    this.calls.push({ url, token });
    await this.onCall?.();
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error(this.failWith);
    }
  };
}
