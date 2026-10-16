import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, listen, rawKey, testApi, userWithSession } from './test-app.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('users API (needs TEST_DATABASE_URL)', () => {
  let t: Awaited<ReturnType<typeof testApi>>;
  let admin: { id: string; cookie: string };
  beforeAll(async () => {
    t = await testApi('woo_api_users_test');
    admin = await userWithSession(t.pool, 'admin@example.com', 'admin');
  });
  afterAll(async () => {
    await t.close();
  });

  const patch = (id: string, body: unknown, cookie = admin.cookie) =>
    call(t.app, 'PATCH', `/api/users/${id}`, { cookie, body });

  it('lists users with active key counts, admin only', async () => {
    const m = await userWithSession(t.pool, 'list@example.com');
    await rawKey(t.pool, m.id);
    await rawKey(t.pool, m.id, true);
    const r = await call(t.app, 'GET', '/api/users', { cookie: admin.cookie });
    expect(r.statusCode).toBe(200);
    const row = r.json().users.find((u: { email: string }) => u.email === 'list@example.com');
    expect(row).toMatchObject({ id: m.id, role: 'member', status: 'active', activeKeys: 1 });
    expect(r.body).not.toContain('password');
    expect((await call(t.app, 'GET', '/api/users', { cookie: m.cookie })).statusCode).toBe(403);
  });

  it('disabling deletes every session and sends key_revoked for every live key', async () => {
    const m = await userWithSession(t.pool, 'dis@example.com');
    const second = await userWithSession(t.pool, 'dis@example.com');
    const live = [await rawKey(t.pool, m.id), await rawKey(t.pool, m.id)];
    await rawKey(t.pool, m.id, true);
    const l = await listen(t.url, 'key_revoked');
    try {
      const r = await patch(m.id, { status: 'disabled' });
      expect(r.statusCode).toBe(200);
      expect(r.json().user).toMatchObject({ id: m.id, status: 'disabled' });
      expect([...(await l.waitFor(2))].sort()).toEqual([...live].sort());
      expect(await l.waitFor(3, 300)).toHaveLength(2);
    } finally {
      await l.close();
    }
    for (const cookie of [m.cookie, second.cookie]) {
      expect((await call(t.app, 'GET', '/api/me', { cookie })).statusCode).toBe(401);
    }
    const s = await t.pool.query('select count(*)::int as n from sessions where user_id = $1', [
      m.id,
    ]);
    expect(s.rows[0].n).toBe(0);
    // The keys stay valid in the database: the gateway rejects them because the user is disabled.
    const k = await t.pool.query(
      'select count(*)::int as n from api_keys where user_id = $1 and revoked_at is null',
      [m.id],
    );
    expect(k.rows[0].n).toBe(2);
  });

  it('disabling revokes every live OAuth refresh token of that user and no one else', async () => {
    const m = await userWithSession(t.pool, 'dis-oauth@example.com');
    const bystander = await userWithSession(t.pool, 'dis-oauth-other@example.com');
    const add = async (userId: string, hash: string, revoked: string | null) =>
      t.pool.query(
        `insert into oauth_refresh_tokens (token_hash, client_id, user_id, resource, scope, expires_at, revoked_at)
         values ($1, 'dcr_x', $2, 'http://mcp.test/mcp', 'mcp:tools', now() + interval '30 days', $3)`,
        [hash, userId, revoked],
      );
    await add(m.id, 'live-1', null);
    await add(m.id, 'live-2', null);
    await add(m.id, 'old-revoked', '2026-01-01T00:00:00Z');
    await add(bystander.id, 'bystander-live', null);
    expect((await patch(m.id, { status: 'disabled' })).statusCode).toBe(200);
    const rows = await t.pool.query<{ token_hash: string; revoked_at: Date | null }>(
      `select token_hash, revoked_at from oauth_refresh_tokens
        where token_hash in ('live-1','live-2','old-revoked','bystander-live') order by token_hash`,
    );
    const by = Object.fromEntries(rows.rows.map((r) => [r.token_hash, r.revoked_at]));
    expect(by['live-1']).not.toBeNull();
    expect(by['live-2']).not.toBeNull();
    expect(by['bystander-live']).toBeNull();
    // A token that was already revoked keeps the time it was revoked.
    expect(by['old-revoked']?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    // Enabling the user again does not bring a grant back: the app must be authorized again.
    await t.pool.query(`update users set password_hash = 'x' where id = $1`, [m.id]);
    expect((await patch(m.id, { status: 'active' })).statusCode).toBe(200);
    const again = await t.pool.query(
      `select count(*)::int as n from oauth_refresh_tokens where user_id = $1 and revoked_at is null`,
      [m.id],
    );
    expect(again.rows[0].n).toBe(0);
  });

  it('a role change also drops the gateway key cache', async () => {
    const m = await userWithSession(t.pool, 'role@example.com');
    const k = await rawKey(t.pool, m.id);
    const l = await listen(t.url, 'key_revoked');
    try {
      expect((await patch(m.id, { role: 'admin' })).json().user.role).toBe('admin');
      expect(await l.waitFor(1)).toEqual([k]);
    } finally {
      await l.close();
    }
  });

  it('re-enables only users who have a password', async () => {
    const m = await userWithSession(t.pool, 'reen@example.com');
    await patch(m.id, { status: 'disabled' });
    expect((await patch(m.id, { status: 'active' })).json()).toEqual({ error: 'invite_pending' });
    await t.pool.query(`update users set password_hash = 'x' where id = $1`, [m.id]);
    expect((await patch(m.id, { status: 'active' })).json().user.status).toBe('active');
  });

  it('refuses changes to yourself and activating an invited user', async () => {
    expect((await patch(admin.id, { role: 'member' })).json()).toEqual({
      error: 'cannot_change_self',
    });
    expect((await patch(admin.id, { status: 'disabled' })).statusCode).toBe(409);
    const inv = await t.pool.query<{ id: string }>(
      `insert into users (email, status) values ('inv@example.com', 'invited') returning id`,
    );
    expect((await patch(inv.rows[0]!.id, { status: 'active' })).json()).toEqual({
      error: 'invite_pending',
    });
  });

  it('answers bad ids with 404 and bad bodies with 400', async () => {
    expect((await patch('not-a-uuid', { role: 'admin' })).statusCode).toBe(404);
    expect(
      (await patch('00000000-0000-4000-8000-000000000000', { role: 'admin' })).statusCode,
    ).toBe(404);
    const m = await userWithSession(t.pool, 'body@example.com');
    expect((await patch(m.id, {})).statusCode).toBe(400);
    expect((await patch(m.id, { email: 'x@example.com' })).statusCode).toBe(400);
    expect((await patch(m.id, { status: 'invited' })).statusCode).toBe(400);
    expect((await patch(m.id.toUpperCase(), { role: 'admin' })).statusCode).toBe(200);
  });

  it('is admin only and needs the Origin', async () => {
    const m = await userWithSession(t.pool, 'nonadmin@example.com');
    expect((await patch(m.id, { role: 'admin' }, m.cookie)).statusCode).toBe(403);
    const noOrigin = await call(t.app, 'PATCH', `/api/users/${m.id}`, {
      cookie: admin.cookie,
      origin: null,
      body: { role: 'admin' },
    });
    expect(noOrigin.statusCode).toBe(403);
  });
});
