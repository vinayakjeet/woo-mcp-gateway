import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateAndSeed } from './migrate-run.js';
import { pruneAudit, RETENTION_LOCK, startAuditRetention } from './retention.js';
import { freshDatabase } from './test-db.js';

const base = process.env.TEST_DATABASE_URL;

describe.skipIf(!base)('audit retention (needs TEST_DATABASE_URL)', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    const url = await freshDatabase(base!, 'woo_retention_test');
    await migrateAndSeed({
      databaseUrl: url,
      kek: randomBytes(32),
      adminEmail: 'admin@example.com',
      adminPassword: 'pw',
      seedServers: [],
    });
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query('delete from audit_events');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function addRow(ageDays: number): Promise<void> {
    await pool.query(
      `insert into audit_events
         (ts, request_id, user_id, user_email, via, server_slug, tool_name, exposed_name,
          outcome, duration_ms, replica)
       values (now() - make_interval(days => $1), gen_random_uuid(), gen_random_uuid(),
               'u@example.com', 'api_key', 'main', 't', 'main__t', 'ok', 1, 'r1')`,
      [ageDays],
    );
  }
  async function remaining(): Promise<number> {
    const { rows } = await pool.query<{ n: string }>('select count(*) as n from audit_events');
    return Number(rows[0]!.n);
  }
  const quietLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it('deletes rows older than 30 days and keeps a row from 29 days ago', async () => {
    for (const d of [31, 45, 29, 1]) await addRow(d);
    expect(await pruneAudit(pool)).toBe(2);
    const { rows } = await pool.query<{ age: number }>(
      `select round(extract(epoch from now() - ts) / 86400)::int as age from audit_events order by ts`,
    );
    expect(rows.map((r) => r.age)).toEqual([29, 1]);
  });

  it('works in batches until a short batch', async () => {
    for (let i = 0; i < 5; i++) await addRow(40 + i);
    await addRow(2);
    const spy = vi.spyOn(pg.Client.prototype, 'query');
    expect(await pruneAudit(pool, { batch: 2 })).toBe(5);
    const deletes = spy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('delete from audit_events'),
    );
    expect(deletes).toHaveLength(3);
    expect(await remaining()).toBe(1);
  });

  it('uses Postgres time, not the process clock', async () => {
    await addRow(29);
    await addRow(31);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 365 * 86_400_000);
    expect(await pruneAudit(pool)).toBe(1);
    expect(await remaining()).toBe(1);
  });

  it('skips the run while another session holds lock 4244, and releases it after a run', async () => {
    await addRow(40);
    const other = new pg.Client({ connectionString: pool.options.connectionString });
    await other.connect();
    try {
      await other.query('select pg_advisory_lock($1)', [RETENTION_LOCK]);
      expect(await pruneAudit(pool)).toBeNull();
      expect(await remaining()).toBe(1);
      await other.query('select pg_advisory_unlock($1)', [RETENTION_LOCK]);

      expect(await pruneAudit(pool)).toBe(1);
      const { rows } = await other.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [
        RETENTION_LOCK,
      ]);
      expect(rows[0]!.ok).toBe(true);
    } finally {
      await other.end();
    }
  });

  it('logs the count at start', async () => {
    await addRow(40);
    await addRow(41);
    const log = quietLog();
    const job = startAuditRetention(pool, log, { everyMs: 3_600_000 });
    await vi.waitFor(() =>
      expect(log.info).toHaveBeenCalledWith({ deleted: 2 }, 'audit retention'),
    );
    await job.stop();
  });

  it('a failed run logs the error code only and the timer keeps going', async () => {
    await addRow(40);
    let calls = 0;
    const flaky = {
      connect: vi.fn(async () => {
        if (calls++ === 0) {
          throw Object.assign(new Error('password authentication failed for user "secret_user"'), {
            code: 'ECONNREFUSED',
          });
        }
        return pool.connect();
      }),
    };
    const log = quietLog();
    const job = startAuditRetention(flaky, log, { everyMs: 25 });
    await vi.waitFor(() =>
      expect(log.info).toHaveBeenCalledWith({ deleted: 1 }, 'audit retention'),
    );
    await job.stop();
    expect(log.warn).toHaveBeenCalledWith({ code: 'ECONNREFUSED' }, 'audit retention failed');
    expect(JSON.stringify([log.warn.mock.calls, log.error.mock.calls])).not.toContain(
      'secret_user',
    );
  });
});
