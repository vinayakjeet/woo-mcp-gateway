import { schema } from '@woo/core/db';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StatusWriter } from './status.js';
import { migratedDatabase, TEST_DATABASE_URL } from './test-db.js';
import { quietLog } from './test-helpers.js';
import type { Db } from './types.js';
import type { UpstreamStatus } from './upstream.js';

describe.skipIf(!TEST_DATABASE_URL)('StatusWriter', () => {
  let url: string;
  let pool: pg.Pool;
  let db: Db;
  let serverId: string;
  const writers: StatusWriter[] = [];

  const up = (s: Partial<UpstreamStatus> = {}) => ({
    record: { id: serverId },
    status: (): UpstreamStatus => ({
      state: 'connected',
      lastOkAt: new Date(),
      lastErrorAt: null,
      lastError: null,
      toolCount: 3,
      ...s,
    }),
  });
  const row = async () =>
    (
      await db
        .select()
        .from(schema.mcpServerStatus)
        .where(eq(schema.mcpServerStatus.serverId, serverId))
    )[0];

  async function pair() {
    const onElected = vi.fn();
    const a = new StatusWriter({ databaseUrl: url, db, log: quietLog, retryMs: 50, onElected });
    const b = new StatusWriter({ databaseUrl: url, db, log: quietLog, retryMs: 50, onElected });
    writers.push(a, b);
    await a.start();
    await b.start();
    const [leader, follower] = a.isLeader ? [a, b] : [b, a];
    return { leader, follower, onElected };
  }

  beforeAll(async () => {
    ({ url, pool, db } = await migratedDatabase('woo_gw_status_test'));
    const [s] = await db
      .insert(schema.mcpServers)
      .values({ slug: 'fx', name: 'FX', url: 'http://fx.test/mcp', kind: 'external' })
      .returning({ id: schema.mcpServers.id });
    serverId = s!.id;
  });
  afterAll(async () => {
    for (const w of writers) await w.close();
    await pool.end();
  });

  it('elects exactly one leader among two writers', async () => {
    const { leader, follower, onElected } = await pair();
    expect(leader.isLeader).toBe(true);
    expect(follower.isLeader).toBe(false);
    expect(onElected).toHaveBeenCalledTimes(1);
    await leader.close();
    await follower.close();
  });

  it('writes only from the leader and notifies only on a state change', async () => {
    const { leader, follower } = await pair();
    const listen = new pg.Client({ connectionString: url });
    const payloads: string[] = [];
    await listen.connect();
    listen.on('notification', (n) => payloads.push(n.payload ?? ''));
    await listen.query('LISTEN status_changed');

    await leader.write(up(), true);
    expect(await row()).toMatchObject({ state: 'connected', toolCount: 3, errorKind: null });
    await leader.write(up({ toolCount: 4 }), false);
    expect((await row())?.toolCount).toBe(4);
    await follower.write(up({ state: 'unreachable' }), true);
    expect((await row())?.state).toBe('connected');
    await new Promise((r) => setTimeout(r, 200));
    expect(payloads).toEqual([serverId]);

    await listen.end();
    await leader.close();
    await follower.close();
  });

  it('sends tools_changed on a state change only, from the leader only', async () => {
    const { leader, follower } = await pair();
    const listen = new pg.Client({ connectionString: url });
    const got: string[] = [];
    await listen.connect();
    listen.on('notification', (n) => got.push(n.payload ?? 'none'));
    await listen.query('LISTEN tools_changed');

    await leader.write(up(), true);
    await leader.write(up({ toolCount: 4 }), false);
    await follower.write(up({ state: 'unreachable' }), true);
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toEqual(['']);

    await listen.end();
    await leader.close();
    await follower.close();
  });

  it('stores the error kind and message', async () => {
    const { leader, follower } = await pair();
    await leader.write(
      up({
        state: 'unreachable',
        lastErrorAt: new Date(),
        lastError: { kind: 'refused', message: 'connection refused' },
      }),
      true,
    );
    expect(await row()).toMatchObject({
      state: 'unreachable',
      errorKind: 'refused',
      errorMessage: 'connection refused',
    });
    await leader.close();
    await follower.close();
  });

  it('prunes rate counters from the lock holder only, once its interval runs', async () => {
    const make = (pruneEveryMs: number) =>
      new StatusWriter({ databaseUrl: url, db, log: quietLog, retryMs: 50, pruneEveryMs });
    const leader = make(1_000_000);
    const follower = make(50);
    writers.push(leader, follower);
    await leader.start();
    await follower.start();
    expect(follower.isLeader).toBe(false);
    await db
      .insert(schema.rateCounters)
      .values({ subject: 'key:stale', windowStart: new Date(Date.now() - 600_000), count: 3 });
    const stale = () =>
      db.select().from(schema.rateCounters).where(eq(schema.rateCounters.subject, 'key:stale'));
    await new Promise((r) => setTimeout(r, 300));
    expect(await stale()).toHaveLength(1);
    await leader.close();
    await vi.waitFor(async () => expect(await stale()).toHaveLength(0), { timeout: 3000 });
    await follower.close();
  });

  it('hands the lock over when the leader closes', async () => {
    const { leader, follower, onElected } = await pair();
    await leader.close();
    await vi.waitFor(() => expect(follower.isLeader).toBe(true), { timeout: 2000 });
    expect(onElected).toHaveBeenCalledTimes(2);
    await follower.close();
  });

  it("hands the lock over when the leader's connection dies", async () => {
    const { leader, follower } = await pair();
    await pool.query(
      "select pg_terminate_backend(l.pid) from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and l.objid = 4242 and l.granted and a.datname = current_database()",
    );
    await vi.waitFor(() => expect(follower.isLeader).toBe(true), { timeout: 2000 });
    expect(leader.isLeader).toBe(false);
    await leader.close();
    await follower.close();
  });
});
