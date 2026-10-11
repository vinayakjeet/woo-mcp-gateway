import { createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildInternalApp, buildPublicApp, type Deps, type UserRow } from './app.js';

const ORIGIN = 'http://app.127.0.0.1.nip.io';
let pwHash = '';
beforeAll(async () => {
  pwHash = await hash('pw-correct');
});

function user(over: Partial<UserRow> = {}): UserRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    status: 'active',
    passwordHash: pwHash,
    ...over,
  };
}

function fakeDeps(u: UserRow | null, over: Partial<Deps> = {}) {
  const sessions: Array<{
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
  }> = [];
  const deps: Deps = {
    ping: async () => true,
    findUserByEmail: async () => u,
    createSession: async (s) => {
      sessions.push(s);
    },
    ...over,
  };
  return { deps, sessions };
}

const login = (
  app: ReturnType<typeof buildPublicApp>,
  body: unknown,
  origin: string | null = ORIGIN,
) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    payload: JSON.stringify(body),
  });

describe('internal health', () => {
  it('healthz is ok', async () => {
    const app = buildInternalApp(fakeDeps(null).deps);
    const r = await app.inject({ url: '/healthz' });
    expect([r.statusCode, r.body]).toEqual([200, 'ok']);
  });
  it('readyz follows ping, including a throwing ping', async () => {
    expect(
      (await buildInternalApp(fakeDeps(null).deps).inject({ url: '/readyz' })).statusCode,
    ).toBe(200);
    const down = fakeDeps(null, { ping: async () => false }).deps;
    expect((await buildInternalApp(down).inject({ url: '/readyz' })).statusCode).toBe(503);
    const boom = fakeDeps(null, {
      ping: async () => {
        throw new Error('db down');
      },
    }).deps;
    expect((await buildInternalApp(boom).inject({ url: '/readyz' })).statusCode).toBe(503);
  });
});

describe('POST /api/auth/login', () => {
  const cfg = { appOrigin: ORIGIN, secureCookies: false };

  it('logs in, stores only the token hash and sets the sid cookie', async () => {
    const { deps, sessions } = fakeDeps(user());
    const app = buildPublicApp(deps, cfg);
    const before = Date.now();
    const r = await login(app, { email: 'admin@example.com', password: 'pw-correct' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      user: { id: user().id, email: 'admin@example.com', name: 'Admin', role: 'admin' },
    });
    expect(r.body).not.toContain('argon2');
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toMatch(
      /^sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/,
    );
    const token = /^sid=([^;]+)/.exec(cookie)![1]!;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(sessions[0]!.expiresAt.getTime() - before).toBeGreaterThan(12 * 3600 * 1000 - 5000);
  });

  it('adds Secure when secureCookies is on', async () => {
    const app = buildPublicApp(fakeDeps(user()).deps, { ...cfg, secureCookies: true });
    const r = await login(app, { email: 'admin@example.com', password: 'pw-correct' });
    expect(String(r.headers['set-cookie'])).toMatch(/; Secure$/);
  });

  it('rejects a missing or foreign Origin without creating a session', async () => {
    const { deps, sessions } = fakeDeps(user());
    const app = buildPublicApp(deps, cfg);
    for (const origin of [null, 'http://evil.example']) {
      const r = await login(app, { email: 'admin@example.com', password: 'pw-correct' }, origin);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: 'bad_origin' });
    }
    expect(sessions).toHaveLength(0);
  });

  it('applies the Origin check to every state-changing route, not only login', async () => {
    const app = buildPublicApp(fakeDeps(user()).deps, cfg);
    app.post('/api/test-echo', async () => ({ ok: true }));
    app.get('/api/test-echo-get', async () => ({ ok: true }));
    await app.ready();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/test-echo',
      headers: { origin: 'http://evil.example' },
    });
    const good = await app.inject({
      method: 'POST',
      url: '/api/test-echo',
      headers: { origin: ORIGIN },
    });
    const get = await app.inject({
      url: '/api/test-echo-get',
      headers: { origin: 'http://evil.example' },
    });
    expect([bad.statusCode, good.statusCode, get.statusCode]).toEqual([403, 200, 200]);
  });

  it.each([
    ['wrong password', user(), 'nope'],
    ['unknown email', null, 'pw-correct'],
    ['disabled user', user({ status: 'disabled' }), 'pw-correct'],
    [
      'invited user without a password',
      user({ status: 'invited', passwordHash: null }),
      'pw-correct',
    ],
  ])('answers 401 invalid_credentials for %s', async (_n, u, password) => {
    const { deps, sessions } = fakeDeps(u);
    const r = await login(buildPublicApp(deps, cfg), { email: 'admin@example.com', password });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'invalid_credentials' });
    expect(sessions).toHaveLength(0);
  });

  it('answers 400 for a missing email or an oversize password', async () => {
    const app = buildPublicApp(fakeDeps(user()).deps, cfg);
    expect((await login(app, { password: 'x' })).statusCode).toBe(400);
    expect(
      (await login(app, { email: 'admin@example.com', password: 'x'.repeat(1025) })).statusCode,
    ).toBe(400);
  });
});
