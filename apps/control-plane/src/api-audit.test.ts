import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './api-audit.js';
import { call, testApi, userWithSession } from './test-app.js';

type U = { id: string; cookie: string };
type Item = { id: string; ts: string; userEmail: string; outcome: string };

describe('audit cursor', () => {
  it('round-trips and refuses anything else', () => {
    const c = encodeCursor('2026-10-05T12:00:00.123004Z', '42');
    expect(decodeCursor(c)).toEqual({ ts: '2026-10-05T12:00:00.123004Z', id: '42' });
    for (const bad of [
      'bad',
      Buffer.from('2026-10-05T12:00:00Z|1').toString('base64url'),
      Buffer.from('2026-10-05T12:00:00.123004Z|x').toString('base64url'),
      Buffer.from('2026-10-05T12:00:00.123004Z|1|2').toString('base64url'),
    ]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('audit API (needs TEST_DATABASE_URL)', () => {
  let t: Awaited<ReturnType<typeof testApi>>;
  let admin: U;
  let alice: U;
  let bob: U;
  let pager: U;
  const insert = (u: U, email: string, slug: string, outcome: string, ts: string) =>
    t.pool.query(
      `insert into audit_events (ts, request_id, user_id, user_email, via, server_slug, tool_name,
         exposed_name, outcome, duration_ms, replica)
       values ($1, gen_random_uuid(), $2, $3, 'api_key', $4, 'get_info', $4 || '__get_info', $5, 12, 'gw-0')`,
      [ts, u.id, email, slug, outcome],
    );
  beforeAll(async () => {
    t = await testApi('woo_api_audit_test');
    admin = await userWithSession(t.pool, 'admin@example.com', 'admin');
    alice = await userWithSession(t.pool, 'alice@example.com');
    bob = await userWithSession(t.pool, 'bob@example.com');
    pager = await userWithSession(t.pool, 'pager@example.com');
    await insert(alice, 'alice@example.com', 'fx', 'ok', '2026-10-01T10:00:00Z');
    await insert(alice, 'alice@example.com', 'main', 'tool_error', '2026-10-02T10:00:00Z');
    await insert(bob, 'bob@example.com', 'fx', 'denied', '2026-10-03T10:00:00Z');
    // 120 rows inside one millisecond: 40 distinct microseconds, 3 rows on each.
    await t.pool.query(
      `insert into audit_events (ts, request_id, user_id, user_email, via, server_slug, tool_name,
         exposed_name, outcome, duration_ms, replica)
       select timestamptz '2026-10-05 12:00:00.123000+00' + (g % 40) * interval '1 microsecond',
         gen_random_uuid(), $1, 'pager@example.com', 'api_key', 'fx', 'get_info', 'fx__get_info',
         'ok', 5, 'gw-0'
       from generate_series(1, 120) g`,
      [pager.id],
    );
  });
  afterAll(async () => {
    await t.close();
  });

  const get = (qs: string, cookie: string) => call(t.app, 'GET', `/api/audit${qs}`, { cookie });
  const emails = (body: { items: Item[] }) => body.items.map((i) => i.userEmail);

  it('shows members only their own rows, whatever they ask for', async () => {
    expect(new Set(emails((await get('', alice.cookie)).json()))).toEqual(
      new Set(['alice@example.com']),
    );
    expect(new Set(emails((await get(`?user=${bob.id}`, alice.cookie)).json()))).toEqual(
      new Set(['alice@example.com']),
    );
  });

  it('shows admins everything and filters by user, server, outcome and time', async () => {
    expect((await get(`?user=${bob.id}`, admin.cookie)).json().items).toHaveLength(1);
    expect(emails((await get('?server=main', admin.cookie)).json())).toEqual(['alice@example.com']);
    expect(emails((await get('?outcome=denied', admin.cookie)).json())).toEqual([
      'bob@example.com',
    ]);
    const range = await get('?from=2026-10-01T00:00:00Z&to=2026-10-03T10:00:00Z', admin.cookie);
    expect(range.json().items.map((i: Item) => i.outcome)).toEqual(['tool_error', 'ok']);
  });

  it('returns rows newest first with every column the page shows', async () => {
    const item = (await get(`?user=${alice.id}`, admin.cookie)).json().items[0];
    expect(item).toMatchObject({
      ts: '2026-10-02T10:00:00.000000Z',
      userEmail: 'alice@example.com',
      via: 'api_key',
      serverSlug: 'main',
      toolName: 'get_info',
      exposedName: 'main__get_info',
      outcome: 'tool_error',
      durationMs: 12,
      replica: 'gw-0',
    });
  });

  it('pages through rows that share a millisecond without skipping or repeating any', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await get(`?user=${pager.id}${cursor ? `&cursor=${cursor}` : ''}`, admin.cookie);
      expect(r.statusCode).toBe(200);
      const body = r.json() as { items: Item[]; nextCursor: string | null };
      seen.push(...body.items.map((i) => `${i.ts}|${i.id.padStart(19, '0')}`));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(120);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it('rejects bad filters and cursors, and needs a session', async () => {
    for (const qs of ['?outcome=nope', '?user=abc', '?from=yesterday', '?cursor=bad', '?limit=5']) {
      expect((await get(qs, admin.cookie)).statusCode).toBe(400);
    }
    expect((await call(t.app, 'GET', '/api/audit')).statusCode).toBe(401);
  });
});
