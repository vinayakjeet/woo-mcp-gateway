import { errorCode } from '@woo/core';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import type { Authenticator } from './auth.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { PG_CONNECT_TIMEOUT_MS } from './pg-options.js';
import type { PolicyStore } from './policies.js';
import type { Registry } from './registry.js';
import { definitionHash, loadServers, upsertTools, type LoadedServer } from './registry-db.js';
import { UUID_RE, type Db, type Log, type ServerRecord } from './types.js';
import { backoffMs, type Upstream } from './upstream.js';

export type SyncOptions = {
  databaseUrl: string;
  db: Db;
  kek: Buffer;
  registry: Pick<Registry, 'apply' | 'remove' | 'ids' | 'setToolStates'>;
  auth: Pick<Authenticator, 'purge' | 'purgeAll'>;
  policies: Pick<PolicyStore, 'load'>;
  log: Log;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  policyRetryMs?: number;
  // The tool lists may have changed: a tools_changed NOTIFY, or a LISTEN connection that came back
  // (NOTIFYs sent while it was down are gone). The listen streams are told once either way.
  onToolsChanged?: () => void;
};

// What mcp_tools holds for one server, as a single comparable string.
function toolsKey(tools: ReadonlyArray<{ name: string; definitionHash: string }>): string {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return canonicalJson(sorted.map((t) => [t.name, t.definitionHash]));
}

const recordKey = (r: ServerRecord) => sha256Hex(canonicalJson(r));

export class GatewaySync {
  loaded = false;
  private readonly persistedKeys = new Map<string, string>();
  // Hash of the record each upstream was applied with. The record holds the decrypted credential, so no copy is kept.
  private readonly appliedRecords = new Map<string, string>();
  private client: pg.Client | null = null;
  private queue: Promise<void> = Promise.resolve();
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  private policyTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly o: SyncOptions) {}

  // LISTEN before the first load, so a change made in between is not missed.
  async start(): Promise<void> {
    await this.listen();
    // A failure here stops startup. Readiness stays false until the rules are in memory.
    await this.o.policies.load();
    await this.reloadAll();
    this.loaded = true;
  }

  // onTools fires on any change to the in-memory list; mcp_tools is written only when a definition hash changes.
  persistTools(u: Pick<Upstream, 'record' | 'tools'>): void {
    const { id, slug, kind } = u.record;
    const tools = u.tools();
    const key = toolsKey(tools.map((t) => ({ name: t.name, definitionHash: definitionHash(t) })));
    if (this.persistedKeys.get(id) === key) return;
    this.persistedKeys.set(id, key);
    void upsertTools(this.o.db, id, slug, kind, tools)
      .then(async (states) => {
        this.o.registry.setToolStates(id, states);
        // Every replica, this one included, hears it on its LISTEN connection.
        await this.o.db.execute(sql`select pg_notify('tools_changed', '')`);
      })
      .catch((err: unknown) => {
        this.persistedKeys.delete(id);
        this.o.log.warn({ server: slug, code: errorCode(err) }, 'tool upsert failed');
      });
  }

  reloadAll(): Promise<void> {
    return this.enqueue(async () => {
      const loaded = await loadServers(this.o.db, this.o.kek);
      const seen = new Set(loaded.map((s) => s.record.id));
      for (const id of this.o.registry.ids()) {
        if (seen.has(id)) continue;
        this.persistedKeys.delete(id);
        this.appliedRecords.delete(id);
        await this.o.registry.remove(id);
      }
      for (const s of loaded) {
        // Rebuilding an upstream drops its connection and resets its breaker: only do it for a real change.
        if (this.appliedRecords.get(s.record.id) === recordKey(s.record)) this.swapStates(s);
        else this.applyLoaded(s);
      }
    });
  }

  // A rule that is deleted or added must not stay stale because one query failed, so a failed
  // reload is retried until it works. The old rules stay in force meanwhile.
  reloadPolicies(): Promise<void> {
    clearTimeout(this.policyTimer);
    return this.enqueue(async () => {
      try {
        await this.o.policies.load();
      } catch (err) {
        this.o.log.warn({ code: errorCode(err) }, 'policy reload failed, retrying');
        if (!this.closed) {
          this.policyTimer = setTimeout(
            () => void this.reloadPolicies().catch(() => {}),
            this.o.policyRetryMs ?? 2000,
          );
          this.policyTimer.unref();
        }
      }
    });
  }

  reloadServer(id: string): Promise<void> {
    return this.enqueue(async () => {
      const [s] = await loadServers(this.o.db, this.o.kek, id);
      if (s) {
        // An approval changes tool states only: keep the connection and the breaker.
        if (this.appliedRecords.get(id) === recordKey(s.record)) this.swapStates(s);
        else this.applyLoaded(s);
      } else {
        this.persistedKeys.delete(id);
        this.appliedRecords.delete(id);
        await this.o.registry.remove(id);
      }
    });
  }

  private swapStates(s: LoadedServer): void {
    this.o.registry.setToolStates(s.record.id, new Map(s.tools.map((t) => [t.name, t.state])));
  }

  // Remember what Postgres holds before the upstream connects, so an unchanged list writes nothing.
  // A server that never synced has no key, so its first list is written even when it is empty.
  private applyLoaded(s: LoadedServer): void {
    if (s.synced)
      this.persistedKeys.set(s.record.id, toolsKey(s.tools.filter((t) => t.state !== 'removed')));
    else this.persistedKeys.delete(s.record.id);
    this.appliedRecords.set(s.record.id, recordKey(s.record));
    this.o.registry.apply(s.record, s.tools);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.policyTimer);
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => {});
    await this.queue;
  }

  // One reload at a time, in arrival order, so an older load never overwrites a newer one.
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn);
    this.queue = run.catch((err: unknown) =>
      this.o.log.warn({ code: errorCode(err) }, 'registry reload failed'),
    );
    return run;
  }

  private async listen(): Promise<void> {
    const c = new pg.Client({
      connectionString: this.o.databaseUrl,
      application_name: 'gateway-listen',
      connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS,
    });
    c.on('notification', (n) => this.onNotify(n.channel, n.payload ?? ''));
    c.on('error', (err) => this.lost(c, err));
    c.on('end', () => this.lost(c));
    try {
      await c.connect();
      await c.query('LISTEN registry_changed');
      await c.query('LISTEN key_revoked');
      await c.query('LISTEN policies_changed');
      await c.query('LISTEN tools_changed');
    } catch (err) {
      await c.end().catch(() => {});
      throw err;
    }
    this.client = c;
    this.attempt = 0;
  }

  private onNotify(channel: string, rawPayload: string): void {
    // The only channel with no id: the event is a hint to list again, and says nothing about what changed.
    if (channel === 'tools_changed') {
      this.o.onToolsChanged?.();
      return;
    }
    if (!UUID_RE.test(rawPayload)) {
      this.o.log.warn({ channel }, 'notification payload is not a uuid');
      return;
    }
    // Postgres prints uuids in lower case, and the caches compare ids as plain strings.
    const payload = rawPayload.toLowerCase();
    if (channel === 'key_revoked') this.o.auth.purge(payload);
    else if (channel === 'registry_changed') void this.reloadServer(payload).catch(() => {});
    else if (channel === 'policies_changed') void this.reloadPolicies();
  }

  private lost(c: pg.Client, err?: unknown): void {
    if (this.client !== c || this.closed) return;
    this.client = null;
    this.o.log.warn({ code: err === undefined ? 'end' : errorCode(err) }, 'listen connection lost');
    void c.end().catch(() => {});
    this.retry();
  }

  private retry(): void {
    const ms = backoffMs(
      this.attempt++,
      this.o.reconnectMinMs ?? 1000,
      this.o.reconnectMaxMs ?? 30_000,
    );
    this.timer = setTimeout(() => void this.relisten(), ms);
    this.timer.unref();
  }

  // NOTIFYs sent while the connection was down are gone, so reload everything and drop cached keys.
  private async relisten(): Promise<void> {
    if (this.closed) return;
    try {
      await this.listen();
      this.o.auth.purgeAll();
      await this.reloadPolicies();
      await this.reloadAll();
      this.o.onToolsChanged?.();
    } catch (err) {
      this.o.log.warn({ code: errorCode(err) }, 'listen reconnect failed');
      const c = this.client;
      this.client = null;
      await c?.end().catch(() => {});
      this.retry();
    }
  }
}
