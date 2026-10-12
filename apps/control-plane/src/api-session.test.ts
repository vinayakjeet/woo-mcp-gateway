import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseId, sidFromCookie } from './api-session.js';
import { ADMIN_PASSWORD, call, testApi, userWithSession } from './test-app.js';

describe('parseId and sidFromCookie', () => {
  it('accepts only uuids and lowercases them', () => {
    expect(parseId({ id: '0F8B0D3E-1C2A-4B5C-8D9E-0A1B2C3D4E5F' })).toBe(
      '0f8b0d3e-1c2a-4b5c-8d9e-0a1b2c3d4e5f',
    );
    for (const id of ['abc', '', '0f8b0d3e1c2a4b5c8d9e0a1b2c3d4e5f', "1' or '1'='1"]) {
      expect(parseId({ id })).toBeNull();
    }
    expect(parseId(null)).toBeNull();
  });
  it('finds sid among other cookies and nowhere else', () => {
    const sid = 'a'.repeat(43);
    expect(sidFromCookie(`theme=dark; sid=${sid}; x=1`)).toBe(sid);
    expect(sidFromCookie(`xsid=${sid}`)).toBeNull();
    expect(sidFromCookie(undefined)).toBeNull();
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('session API (needs TEST_DATABASE_URL)', () => {
  let t: Awaited<ReturnType<typeof testApi>>;
  beforeAll(async () => {
    t = await testApi('woo_api_session_test');
  });
  afterAll(async () => {
    await t.close();
  });

  it('GET /api/me needs a live session of an active user', async () => {
    expect((await call(t.app, 'GET', '/api/me')).statusCode).toBe(401);
    const m = await userWithSession(t.pool, 'm1@example.com');
    const r = await call(t.app, 'GET', '/api/me', { cookie: m.cookie });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      user: { id: m.id, email: 'm1@example.com', name: null, role: 'member' },
    });
    await t.pool.query(
      `update sessions set expires_at = now() - interval '1 second' where user_id = $1`,
      [m.id],
    );
    expect((await call(t.app, 'GET', '/api/me', { cookie: m.cookie })).statusCode).toBe(401);
  });

  it('a disabled user is signed out at once', async () => {
    const m = await userWithSession(t.pool, 'm2@example.com');
    await t.pool.query(`update users set status = 'disabled' where id = $1`, [m.id]);
    expect((await call(t.app, 'GET', '/api/me', { cookie: m.cookie })).statusCode).toBe(401);
  });

  it('the cookie from login works on /api/me', async () => {
    const r = await call(t.app, 'POST', '/api/auth/login', {
      body: { email: 'admin@example.com', password: ADMIN_PASSWORD },
    });
    const sid = String(r.headers['set-cookie']).split(';')[0]!;
    expect((await call(t.app, 'GET', '/api/me', { cookie: sid })).json().user.role).toBe('admin');
  });

  it('logout needs the Origin, deletes the session and clears the cookie', async () => {
    const m = await userWithSession(t.pool, 'm3@example.com');
    const noOrigin = await call(t.app, 'POST', '/api/auth/logout', {
      cookie: m.cookie,
      origin: null,
    });
    expect(noOrigin.statusCode).toBe(403);
    const r = await call(t.app, 'POST', '/api/auth/logout', { cookie: m.cookie });
    expect(r.statusCode).toBe(204);
    expect(r.headers['set-cookie']).toBe('sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    expect((await call(t.app, 'GET', '/api/me', { cookie: m.cookie })).statusCode).toBe(401);
    expect((await t.pool.query('select 1 from sessions where user_id = $1', [m.id])).rowCount).toBe(
      0,
    );
  });

  it('a garbage cookie is unauthenticated, not an error', async () => {
    const r = await call(t.app, 'GET', '/api/me', { cookie: 'sid=%%%; other=1' });
    expect(r.statusCode).toBe(401);
  });

  it('GET /api/config is public', async () => {
    const r = await call(t.app, 'GET', '/api/config');
    expect(r.json()).toEqual({ gatewayUrl: 'http://mcp.127.0.0.1.nip.io/mcp', version: 'test' });
  });
});
