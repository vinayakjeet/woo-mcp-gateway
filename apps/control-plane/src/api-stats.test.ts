import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, testApi, userWithSession } from './test-app.js';

type U = { id: string; cookie: string };
type Server = {
  slug: string;
  name: string;
  kind: string;
  enabled: boolean;
  approval: string;
  state: string | null;
  errorKind: string | null;
  errorMessage: string | null;
  checkedAt: string | null;
  calls: number;
  callsPerMinute: number;
  outcomes: Record<string, number>;
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
};
type Body = { windowMinutes: number; servers: Server[] };

describe.skipIf(!process.env.TEST_DATABASE_URL)('stats API (needs TEST_DATABASE_URL)', () => {
  let t: Awaited<ReturnType<typeof testApi>>;
  let admin: U;
  let member: U;

  const server = (slug: string, kind = 'external') =>
    t.pool.query<{ id: string }>(
      `insert into mcp_servers (slug, name, url, kind) values ($1, $2, 'http://x.test/mcp', $3)
       returning id`,
      [slug, slug.toUpperCase(), kind],
    );
  // Rows are placed minutes ago, so they fall inside or outside the window as the test needs.
  const audit = (slug: string, outcome: string, ms: number, minutesAgo: number, meta = false) =>
    t.pool.query(
      `insert into audit_events (ts, request_id, user_id, user_email, via, server_slug, tool_name,
         exposed_name, meta_tool, outcome, duration_ms, replica)
       values (now() - $1 * interval '1 minute', gen_random_uuid(), $2, 'a@example.com', 'api_key',
         $3, 'get_info', $3 || '__get_info', $4, $5, $6, 'gw-0')`,
      [minutesAgo, admin.id, slug, meta ? 'search_tools' : null, outcome, ms],
    );
  const get = (qs: string, cookie: string | undefined) =>
    call(t.app, 'GET', `/api/stats/servers${qs}`, { cookie });
  const bySlug = (b: Body) => Object.fromEntries(b.servers.map((s) => [s.slug, s]));

  beforeAll(async () => {
    t = await testApi('woo_api_stats_test');
    admin = await userWithSession(t.pool, 'admin@example.com', 'admin');
    member = await userWithSession(t.pool, 'member@example.com');
    const main = await server('main', 'store');
    await server('fx', 'system');
    await server('quiet');
    await t.pool.query(
      `insert into mcp_server_status (server_id, state, error_kind, error_message, checked_at)
       values ($1, 'unreachable', 'refused', 'connection refused', now())`,
      [main.rows[0]!.id],
    );
    // main: ten ok calls of 100, 200 ... 1000 ms. Percentile: p50 = 550, p95 = 955.
    for (let i = 1; i <= 10; i++) await audit('main', 'ok', i * 100, 5);
    // Counted in calls, not in attempted: no duration, no error.
    await audit('main', 'denied', 1, 5);
    await audit('main', 'rate_limited', 1, 5);
    await audit('main', 'disabled', 1, 5);
    await audit('main', 'bad_request', 1, 5);
    // Outside the 60 minute window.
    await audit('main', 'timeout', 15000, 90);
    // fx: 2 ok (10 ms, 30 ms) and 1 tool_error (20 ms), 1 timeout (15000 ms), 1 unreachable (1 ms).
    await audit('fx', 'ok', 10, 1);
    await audit('fx', 'ok', 30, 1);
    await audit('fx', 'tool_error', 20, 1);
    await audit('fx', 'timeout', 15000, 2);
    await audit('fx', 'unreachable', 1, 2);
    await audit('fx', 'upstream_error', 5, 2);
    // search_tools rows carry an empty slug and belong to no server.
    await audit('', 'ok', 3, 1, true);
  }, 30_000);
  afterAll(async () => {
    await t.close();
  });

  it('computes p50 and p95 from the attempted calls of the window', async () => {
    const b = (await get('', admin.cookie)).json() as Body;
    expect(bySlug(b).main).toMatchObject({ p50Ms: 550, p95Ms: 955 });
  });

  it('counts tool_error, timeout, unreachable and upstream_error over attempted calls', async () => {
    const fx = bySlug((await get('', admin.cookie)).json() as Body).fx!;
    // attempted 6 (2 ok, 1 tool_error, 1 timeout, 1 unreachable, 1 upstream_error), 4 not ok.
    expect(fx.calls).toBe(6);
    expect(fx.errorRate).toBeCloseTo(4 / 6, 10);
    expect(fx.outcomes).toEqual({
      ok: 2,
      tool_error: 1,
      timeout: 1,
      unreachable: 1,
      upstream_error: 1,
    });
  });

  it('counts denied, bad_request, rate_limited and disabled in calls but not in attempted', async () => {
    const main = bySlug((await get('', admin.cookie)).json() as Body).main!;
    expect(main.calls).toBe(14);
    expect(main.errorRate).toBe(0);
    expect(main.outcomes).toMatchObject({ ok: 10, denied: 1, rate_limited: 1, disabled: 1 });
    expect(main.outcomes.bad_request).toBe(1);
    expect(main.callsPerMinute).toBeCloseTo(14 / 60, 10);
  });

  it('ignores rows outside the window and follows a wider window', async () => {
    const narrow = bySlug((await get('?window=60m', admin.cookie)).json() as Body).main!;
    expect(narrow.outcomes.timeout).toBeUndefined();
    const wide = (await get('?window=120m', admin.cookie)).json() as Body;
    expect(wide.windowMinutes).toBe(120);
    expect(bySlug(wide).main!.outcomes.timeout).toBe(1);
    expect(bySlug(wide).main!.calls).toBe(15);
    expect(bySlug(wide).main!.callsPerMinute).toBeCloseTo(15 / 120, 10);
  });

  it('skips search_tools rows with an empty slug', async () => {
    const b = (await get('', admin.cookie)).json() as Body;
    expect(b.servers.map((s) => s.slug).sort()).toEqual(['fx', 'main', 'quiet']);
    expect(b.servers.reduce((n, s) => n + s.calls, 0)).toBe(20);
  });

  it('does not count oauth_grant_revoked rows as tool calls', async () => {
    const before = (await get('', admin.cookie)).json() as Body;
    // Same shape the revoke route writes: owner as user, via oauth, empty slug, client id as exposed name.
    await t.pool.query(
      `insert into audit_events (ts, request_id, user_id, user_email, via, server_slug, tool_name,
         exposed_name, outcome, duration_ms, error_message, replica)
       select now() - interval '1 minute', gen_random_uuid(), $1, 'a@example.com', 'oauth', '',
         'oauth_grant_revoked', 'dcr_client_' || n, 'ok', 0, 'revoked by admin@example.com', 'cp-0'
       from generate_series(1, 5) n`,
      [admin.id],
    );
    try {
      const after = await get('', admin.cookie);
      expect(after.json()).toEqual(before);
      expect(after.body).not.toContain('oauth_grant_revoked');
    } finally {
      await t.pool.query(`delete from audit_events where tool_name = 'oauth_grant_revoked'`);
    }
  });

  it('lists a server with no calls with zero calls and null rates', async () => {
    const quiet = bySlug((await get('', admin.cookie)).json() as Body).quiet!;
    expect(quiet).toMatchObject({
      calls: 0,
      callsPerMinute: 0,
      outcomes: {},
      errorRate: null,
      p50Ms: null,
      p95Ms: null,
      state: null,
    });
  });

  it('takes state, error kind and message from mcp_server_status', async () => {
    const main = bySlug((await get('', admin.cookie)).json() as Body).main!;
    expect(main).toMatchObject({
      name: 'MAIN',
      kind: 'store',
      enabled: true,
      approval: 'approved',
      state: 'unreachable',
      errorKind: 'refused',
      errorMessage: 'connection refused',
    });
    expect(main.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('answers 400 for a bad window and defaults to 60m', async () => {
    for (const w of ['0m', '1441m', '60', '1h', '-5m', '1.5m', 'abcm', '']) {
      expect((await get(`?window=${w}`, admin.cookie)).statusCode).toBe(400);
    }
    expect((await get('?window=1m', admin.cookie)).statusCode).toBe(200);
    expect((await get('?window=1440m', admin.cookie)).statusCode).toBe(200);
    expect((await get('?other=1', admin.cookie)).statusCode).toBe(400);
    expect(((await get('', admin.cookie)).json() as Body).windowMinutes).toBe(60);
  });

  it('gives a member the same numbers and refuses a request without a session', async () => {
    const a = (await get('', admin.cookie)).json();
    const m = await get('', member.cookie);
    expect(m.statusCode).toBe(200);
    expect(m.json()).toEqual(a);
    expect((await get('', undefined)).statusCode).toBe(401);
  });

  it('does not expose users, emails or arguments', async () => {
    const text = (await get('', admin.cookie)).body;
    expect(text).not.toContain('a@example.com');
    expect(text).not.toContain(admin.id);
  });
});
