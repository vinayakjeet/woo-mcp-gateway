import { hashToken } from '@woo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVITE_TTL_MS } from './api-invites.js';
import { call, testApi, userWithSession } from './test-app.js';

const tokenOf = (url: string) => new URL(url).pathname.split('/').pop()!;
const PASSWORD = 'correct horse battery';

describe.skipIf(!process.env.TEST_DATABASE_URL)('invites API (needs TEST_DATABASE_URL)', () => {
  let t: Awaited<ReturnType<typeof testApi>>;
  let admin: { id: string; cookie: string };
  beforeAll(async () => {
    t = await testApi('woo_api_invites_test');
    admin = await userWithSession(t.pool, 'admin@example.com', 'admin');
  });
  afterAll(async () => {
    await t.close();
  });

  const invite = async (email: string, role = 'member') => {
    const r = await call(t.app, 'POST', '/api/invites', {
      cookie: admin.cookie,
      body: { email, role },
    });
    return { r, token: r.statusCode === 201 ? tokenOf(r.json().url) : '' };
  };
  const accept = (token: string, body: unknown = { password: PASSWORD }) =>
    call(t.app, 'POST', `/api/invites/${token}/accept`, { body });

  it('creates a 72 hour link on the app origin and an invited user', async () => {
    const before = Date.now();
    const { r, token } = await invite('new1@example.com');
    expect(r.statusCode).toBe(201);
    expect(r.json().url).toMatch(
      /^http:\/\/app\.127\.0\.0\.1\.nip\.io\/invite\/[A-Za-z0-9_-]{43}$/,
    );
    const ttl = Date.parse(r.json().expiresAt) - before;
    expect(ttl).toBeGreaterThanOrEqual(INVITE_TTL_MS - 1000);
    expect(ttl).toBeLessThanOrEqual(INVITE_TTL_MS + 5000);
    const u = await t.pool.query(
      `select status, role, password_hash from users where email = 'new1@example.com'`,
    );
    expect(u.rows[0]).toEqual({ status: 'invited', role: 'member', password_hash: null });
    // Stored the way sessions are: only sha256(token), and the raw token appears in no column.
    const stored = await t.pool.query(
      `select token_hash, row_to_json(i)::text as row from invites i where email = 'new1@example.com'`,
    );
    expect(stored.rows[0].token_hash).toBe(hashToken(token));
    expect(stored.rows[0].row).not.toContain(token);
  });

  it('is admin only and needs the Origin', async () => {
    const m = await userWithSession(t.pool, 'member1@example.com');
    const body = { email: 'x@example.com', role: 'member' };
    expect((await call(t.app, 'POST', '/api/invites', { cookie: m.cookie, body })).statusCode).toBe(
      403,
    );
    expect((await call(t.app, 'POST', '/api/invites', { body })).statusCode).toBe(401);
    const noOrigin = await call(t.app, 'POST', '/api/invites', {
      cookie: admin.cookie,
      origin: null,
      body,
    });
    expect(noOrigin.statusCode).toBe(403);
  });

  it('shows the invite, accepts once, signs the user in and the password works', async () => {
    const { token } = await invite('new2@example.com', 'admin');
    expect((await call(t.app, 'GET', `/api/invites/${token}`)).json()).toEqual({
      email: 'new2@example.com',
      role: 'admin',
    });
    const r = await accept(token, { password: PASSWORD, name: 'New Two' });
    expect(r.statusCode).toBe(200);
    expect(r.json().user).toMatchObject({
      email: 'new2@example.com',
      name: 'New Two',
      role: 'admin',
    });
    const sid = String(r.headers['set-cookie']).split(';')[0]!;
    expect((await call(t.app, 'GET', '/api/me', { cookie: sid })).json().user.email).toBe(
      'new2@example.com',
    );
    const login = await call(t.app, 'POST', '/api/auth/login', {
      body: { email: 'new2@example.com', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    expect((await accept(token)).statusCode).toBe(404);
    expect((await call(t.app, 'GET', `/api/invites/${token}`)).statusCode).toBe(404);
  });

  it('lets exactly one of two concurrent accepts through', async () => {
    const { token } = await invite('new3@example.com');
    const codes = (await Promise.all([accept(token), accept(token)])).map((r) => r.statusCode);
    expect(codes.sort()).toEqual([200, 404]);
    const n = await t.pool.query(
      `select count(*)::int as n from sessions s join users u on u.id = s.user_id
       where u.email = 'new3@example.com'`,
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('rejects expired, replaced, unknown and malformed tokens', async () => {
    const { token: expired } = await invite('new4@example.com');
    await t.pool.query(
      `update invites set expires_at = now() - interval '1 second' where email = 'new4@example.com'`,
    );
    expect((await call(t.app, 'GET', `/api/invites/${expired}`)).statusCode).toBe(404);
    expect((await accept(expired)).statusCode).toBe(404);
    const { token: first } = await invite('new5@example.com');
    const { token: second } = await invite('new5@example.com');
    expect((await accept(first)).statusCode).toBe(404);
    expect((await accept(second)).statusCode).toBe(200);
    expect((await call(t.app, 'GET', `/api/invites/${'a'.repeat(43)}`)).statusCode).toBe(404);
    expect((await call(t.app, 'GET', '/api/invites/short')).statusCode).toBe(404);
    expect((await accept('short')).statusCode).toBe(404);
  });

  it('refuses to invite an existing user, and a short password keeps the link usable', async () => {
    expect((await invite('admin@example.com')).r.json()).toEqual({ error: 'user_exists' });
    const { token } = await invite('new6@example.com');
    expect((await accept(token, { password: 'short' })).statusCode).toBe(400);
    expect((await accept(token)).statusCode).toBe(200);
  });

  it('does not activate a user an admin disabled after inviting', async () => {
    const { token } = await invite('new7@example.com');
    await t.pool.query(`update users set status = 'disabled' where email = 'new7@example.com'`);
    expect((await accept(token)).statusCode).toBe(404);
    const s = await t.pool.query(`select status from users where email = 'new7@example.com'`);
    expect(s.rows[0].status).toBe('disabled');
  });
});
