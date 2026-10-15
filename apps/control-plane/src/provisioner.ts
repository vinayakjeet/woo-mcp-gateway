import { errorCode } from '@woo/core';
import pg from 'pg';
import { reconcileHosted, type HostedDeps } from './hosted-reconcile.js';
import {
  JOB_SELECT,
  provisionStore,
  teardownStore,
  type Log,
  type ReconcileDeps,
  type StoreJob,
} from './reconcile.js';

export const PROVISIONER_LOCK = 4243;
export const MAX_PARALLEL = 3;
const TICK_MS = 5000;
const LOCK_RETRY_MS = 10_000;

export type ProvisionerOptions = {
  databaseUrl: string;
  deps: ReconcileDeps;
  // Hosted servers (SPEC 21). Left out, the pass does not run.
  hosted?: HostedDeps;
  log: Log;
  tickMs?: number;
  lockRetryMs?: number;
};

// SPEC 18: only the replica holding advisory lock 4243 reconciles. The lock lives on its own
// session (same pattern as the gateway's status writer), and LISTEN runs on that session, so a
// replica hears stores_changed and hosted_changed only while it leads.
export class Provisioner {
  private lockClient: pg.Client | null = null;
  private leader = false;
  private closed = false;
  private lockTimer: NodeJS.Timeout | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private ticking = false;
  private again = false;
  private readonly inflight = new Map<string, AbortController>();
  private readonly running = new Set<Promise<void>>();
  private hostedAc: AbortController | null = null;

  constructor(private readonly o: ProvisionerOptions) {}

  get isLeader(): boolean {
    return this.leader;
  }

  get inFlight(): number {
    return this.inflight.size;
  }

  async start(): Promise<void> {
    await this.tryLead();
  }

  // Resolves once every pass started so far has finished.
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  kick(): void {
    if (!this.leader || this.closed) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    void this.tick();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.lockTimer);
    clearTimeout(this.tickTimer);
    // While helm runs, the lock session stays open until the process exits. Node is PID 1, so its
    // exit kills helm and closes the session together, and the next leader never runs helm on a
    // release that a dying replica's helm still works on.
    if (this.inflight.size > 0) return;
    this.leader = false;
    const c = this.lockClient;
    this.lockClient = null;
    await c?.end().catch(() => {});
  }

  private async tick(): Promise<void> {
    this.ticking = true;
    try {
      do {
        this.again = false;
        // Before the store limit check: hosted work is a few API calls, not a helm run, so it
        // must not wait behind three stores that are installing.
        await this.hostedPass();
        if (this.inflight.size >= MAX_PARALLEL) break;
        const r = await this.o.deps.pool.query<StoreJob>(
          `${JOB_SELECT} where status in ('provisioning', 'deleting') order by created_at`,
        );
        for (const job of r.rows) {
          if (this.inflight.size >= MAX_PARALLEL || !this.leader) break;
          if (!this.inflight.has(job.id)) this.run(job);
        }
      } while (this.again && this.leader && !this.closed);
    } catch (err) {
      this.o.log.warn({ code: errorCode(err) }, 'store reconcile tick failed');
    } finally {
      this.ticking = false;
    }
  }

  // Awaited inside the tick. It never sleeps (a delete that waits for pods returns and the next
  // tick looks again), so it cannot hold up store installs for long.
  private async hostedPass(): Promise<void> {
    const h = this.o.hosted;
    if (!h || !this.leader) return;
    const ac = new AbortController();
    this.hostedAc = ac;
    try {
      await reconcileHosted(h, ac.signal);
    } catch (err) {
      this.o.log.warn({ code: errorCode(err) }, 'hosted reconcile pass failed');
    } finally {
      this.hostedAc = null;
    }
  }

  // A finished pass does not kick the loop: a store that keeps failing would retry in a tight
  // loop. The tick is the retry delay; status changes NOTIFY and start queued stores at once.
  private run(job: StoreJob): void {
    const ac = new AbortController();
    this.inflight.set(job.id, ac);
    // Dispatch is by status only. A provisioning row is picked up whatever its deadline, so the
    // pass can fail it once the deadline has gone (Task 12); deleting rows have no deadline.
    const pass = job.status === 'deleting' ? teardownStore : provisionStore;
    const p: Promise<void> = pass(this.o.deps, job, ac.signal)
      .catch((err: unknown) => {
        this.o.log.warn({ store: job.slug, code: errorCode(err) }, 'store reconcile failed');
      })
      .finally(() => {
        this.inflight.delete(job.id);
        this.running.delete(p);
      });
    this.running.add(p);
  }

  private async tryLead(): Promise<void> {
    if (this.closed) return;
    try {
      if (!this.lockClient) {
        const c = new pg.Client({
          connectionString: this.o.databaseUrl,
          application_name: 'control-plane-provisioner',
        });
        c.on('error', (err) => this.lost(c, err));
        c.on('end', () => this.lost(c));
        c.on('notification', () => this.kick());
        await c.connect();
        this.lockClient = c;
      }
      const { rows } = await this.lockClient.query<{ ok: boolean }>(
        'select pg_try_advisory_lock($1) as ok',
        [PROVISIONER_LOCK],
      );
      if (rows[0]?.ok) {
        await this.lockClient.query('LISTEN stores_changed');
        if (this.o.hosted) await this.lockClient.query('LISTEN hosted_changed');
        this.leader = true;
        this.o.log.info({ lock: PROVISIONER_LOCK }, 'store provisioner elected');
        this.scheduleTick();
        this.kick();
        return;
      }
    } catch (err) {
      this.o.log.warn({ code: errorCode(err) }, 'provisioner lock attempt failed');
      const c = this.lockClient;
      this.lockClient = null;
      await c?.end().catch(() => {});
    }
    this.scheduleLock();
  }

  private lost(c: pg.Client, err?: unknown): void {
    if (this.lockClient !== c || this.closed) return;
    this.lockClient = null;
    this.leader = false;
    clearTimeout(this.tickTimer);
    // Another replica can take the lock now, so helm must not keep running here.
    for (const ac of this.inflight.values()) ac.abort();
    this.hostedAc?.abort();
    this.o.log.warn(
      { code: err === undefined ? 'end' : errorCode(err) },
      'provisioner lock connection lost',
    );
    void c.end().catch(() => {});
    this.scheduleLock();
  }

  private scheduleLock(): void {
    clearTimeout(this.lockTimer);
    if (this.closed) return;
    this.lockTimer = setTimeout(() => void this.tryLead(), this.o.lockRetryMs ?? LOCK_RETRY_MS);
    this.lockTimer.unref();
  }

  private scheduleTick(): void {
    clearTimeout(this.tickTimer);
    if (this.closed || !this.leader) return;
    this.tickTimer = setTimeout(() => {
      this.kick();
      this.scheduleTick();
    }, this.o.tickMs ?? TICK_MS);
    this.tickTimer.unref();
  }
}
