import type pg from 'pg';

export type Channel = 'key_revoked' | 'registry_changed';

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let broken = false;
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (err) {
    // A connection whose rollback failed is in an unknown state, so it is destroyed, not reused.
    await c.query('rollback').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    c.release(broken);
  }
}

// Postgres delivers a NOTIFY only when its transaction commits, so a change that rolls back
// never reaches the gateway.
export async function notify(c: pg.PoolClient, channel: Channel, id: string): Promise<void> {
  await c.query('select pg_notify($1, $2)', [channel, id]);
}
