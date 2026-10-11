import { errorCode } from '@woo/core';
import { schema } from '@woo/core/db';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import type { Db, Log } from './types.js';
import type { UpstreamStatus } from './upstream.js';

export const STATUS_LOCK = 4242;

export type StatusWriterOptions = {
  databaseUrl: string;
  db: Db;
  log: Log;
  retryMs?: number;
  onElected?: () => void;
};

// Every replica checks its own upstreams; only the holder of the session lock writes rows,
// so status does not flap between replicas that briefly disagree.
export class StatusWriter {
  private lockClient: pg.Client | null = null;
  private leader = false;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly o: StatusWriterOptions) {}

  get isLeader(): boolean {
    return this.leader;
  }

  async start(): Promise<void> {
    await this.tryLead();
  }

  async write(
    u: { record: { id: string }; status(): UpstreamStatus },
    changed: boolean,
  ): Promise<void> {
    if (!this.leader) return;
    const s = u.status();
    const values = {
      state: s.state,
      lastOkAt: s.lastOkAt,
      lastErrorAt: s.lastErrorAt,
      errorKind: s.lastError?.kind ?? null,
      errorMessage: s.lastError?.message ?? null,
      toolCount: s.toolCount,
      checkedAt: new Date(),
    };
    await this.o.db
      .insert(schema.mcpServerStatus)
      .values({ serverId: u.record.id, ...values })
      .onConflictDoUpdate({ target: schema.mcpServerStatus.serverId, set: values });
    if (changed) await this.o.db.execute(sql`select pg_notify('status_changed', ${u.record.id})`);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.leader = false;
    clearTimeout(this.timer);
    const c = this.lockClient;
    this.lockClient = null;
    // Ending the session releases the lock.
    await c?.end().catch(() => {});
  }

  private async tryLead(): Promise<void> {
    if (this.closed) return;
    try {
      if (!this.lockClient) {
        const c = new pg.Client({
          connectionString: this.o.databaseUrl,
          application_name: 'gateway-status-lock',
        });
        c.on('error', (err) => this.lost(c, err));
        c.on('end', () => this.lost(c));
        await c.connect();
        this.lockClient = c;
      }
      const { rows } = await this.lockClient.query<{ ok: boolean }>(
        'select pg_try_advisory_lock($1) as ok',
        [STATUS_LOCK],
      );
      if (rows[0]?.ok) {
        this.leader = true;
        this.o.log.info({ lock: STATUS_LOCK }, 'status writer elected');
        this.o.onElected?.();
        return;
      }
    } catch (err) {
      this.o.log.warn({ code: errorCode(err) }, 'status lock attempt failed');
      const c = this.lockClient;
      this.lockClient = null;
      await c?.end().catch(() => {});
    }
    this.schedule();
  }

  private lost(c: pg.Client, err?: unknown): void {
    if (this.lockClient !== c || this.closed) return;
    this.lockClient = null;
    this.leader = false;
    this.o.log.warn(
      { code: err === undefined ? 'end' : errorCode(err) },
      'status lock connection lost',
    );
    void c.end().catch(() => {});
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.timer = setTimeout(() => void this.tryLead(), this.o.retryMs ?? 10_000);
    this.timer.unref();
  }
}
