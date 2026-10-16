import type pg from 'pg';

export type Channel =
  | 'key_revoked'
  | 'registry_changed'
  | 'stores_changed'
  | 'hosted_changed'
  | 'policies_changed'
  | 'tools_changed';

// A change to a server row or to a policy can change what a client sees in tools/list.
const CHANGES_TOOLS: ReadonlySet<Channel> = new Set(['registry_changed', 'policies_changed']);

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
  // Sent here, in the same transaction, so no caller can change a tool list and forget the hint. The
  // payload is empty on purpose: gateways tell their listen streams to list again, and each client
  // gets its own filtered list, so the event says nothing about a server a member cannot see.
  if (CHANGES_TOOLS.has(channel)) await c.query("select pg_notify('tools_changed', '')");
}
