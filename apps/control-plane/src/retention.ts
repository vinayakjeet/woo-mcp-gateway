import { errorCode } from '@woo/core';
import type pg from 'pg';
import type { Log } from './reconcile.js';

export const RETENTION_LOCK = 4244;
const BATCH = 10_000;
const DAY_MS = 86_400_000;

type Db = Pick<pg.Pool, 'connect'>;

// SPEC 9. Postgres time sets the cutoff, never the pod clock: the clock can jump (WSL) and differs
// between replicas. Returns null when another session holds the lock.
export async function pruneAudit(db: Db, opts: { batch?: number } = {}): Promise<number | null> {
  const batch = opts.batch ?? BATCH;
  const c = await db.connect();
  let locked = false;
  let broken = false;
  try {
    const got = await c.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [
      RETENTION_LOCK,
    ]);
    if (!got.rows[0]?.ok) return null;
    locked = true;
    let total = 0;
    for (;;) {
      const res = await c.query(
        `delete from audit_events where id in (
           select id from audit_events where ts < now() - interval '30 days' order by ts limit $1)`,
        [batch],
      );
      const n = res.rowCount ?? 0;
      total += n;
      if (n < batch) return total;
    }
  } catch (err) {
    broken = true;
    throw err;
  } finally {
    if (locked) {
      await c.query('select pg_advisory_unlock($1)', [RETENTION_LOCK]).catch(() => {
        broken = true;
      });
    }
    // A destroyed connection drops its session lock, so a failed unlock cannot strand the lock.
    c.release(broken);
  }
}

export function startAuditRetention(
  db: Db,
  log: Log,
  o: { everyMs?: number } = {},
): { stop(): Promise<void> } {
  let running: Promise<void> = Promise.resolve();
  const run = async (): Promise<void> => {
    try {
      const deleted = await pruneAudit(db);
      if (deleted === null)
        log.info({ lock: RETENTION_LOCK }, 'audit retention skipped, lock held');
      else log.info({ deleted }, 'audit retention');
    } catch (err) {
      log.warn({ code: errorCode(err) }, 'audit retention failed');
    }
  };
  const tick = (): void => {
    running = run();
  };
  tick();
  const timer = setInterval(tick, o.everyMs ?? DAY_MS);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
