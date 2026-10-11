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

describe('login rate limits', () => {
  const post = (
    app: ReturnType<typeof buildPublicApp>,
    email: string,
    xff?: string,
    origin: string | null = ORIGIN,
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        'content-type': 'application/json',
        ...(origin ? { origin } : {}),
        ...(xff ? { 'x-forwarded-for': xff } : {}),
      },
      payload: JSON.stringify({ email, password: 'pw-wrong' }),
    });
  const publicApp = () =>
    buildPublicApp(fakeDeps(null).deps, { appOrigin: ORIGIN, secureCookies: false });

  it('allows 10 attempts per minute per IP and answers 429 after that', async () => {
    const app = publicApp();
    for (let i = 0; i < 10; i++) {
      expect((await post(app, `u${i}@example.com`, '203.0.113.7')).statusCode).toBe(401);
    }
    const r = await post(app, 'u10@example.com', '203.0.113.7');
    expect(r.statusCode).toBe(429);
    expect(r.json()).toEqual({ error: 'rate_limited' });
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect((await post(app, 'u11@example.com', '203.0.113.8')).statusCode).toBe(401);
  });

  it('allows 5 attempts per minute per email across IPs, case-insensitively', async () => {
    const app = publicApp();
    const emails = ['Target@Example.com', 'target@example.com', 'TARGET@example.com'];
    for (let i = 0; i < 5; i++) {
      expect((await post(app, emails[i % 3]!, `198.51.100.${i}`)).statusCode).toBe(401);
    }
    const r = await post(app, 'target@example.com', '198.51.100.99');
    expect(r.statusCode).toBe(429);
    expect(r.json()).toEqual({ error: 'rate_limited' });
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect((await post(app, 'other@example.com', '198.51.100.99')).statusCode).toBe(401);
  });

  it('trusts only the address the proxy added, so a forged left entry does not reset the IP limit', async () => {
    const app = publicApp();
    for (let i = 0; i < 10; i++) {
      expect((await post(app, `s${i}@example.com`, `forged-${i}, 192.0.2.50`)).statusCode).toBe(
        401,
      );
    }
    expect((await post(app, 's10@example.com', 'forged-x, 192.0.2.50')).statusCode).toBe(429);
  });

  it('does not count requests that fail the Origin check', async () => {
    const app = publicApp();
    for (let i = 0; i < 20; i++) {
      expect((await post(app, 'v@example.com', '192.0.2.60', null)).statusCode).toBe(403);
    }
    expect((await post(app, 'v@example.com', '192.0.2.60')).statusCode).toBe(401);
  });
});

describe('error handling', () => {
  it('logs the error code and route, never the message, and answers 500 without detail', async () => {
    const lines: string[] = [];
    const drizzleLike = Object.assign(
      new Error('Failed query: insert into sessions ...\nparams: LEAKMARKER,hunter2'),
      { cause: Object.assign(new Error('boom'), { code: '23505' }) },
    );
    const { deps } = fakeDeps(user(), {
      createSession: async () => {
        throw drizzleLike;
      },
    });
    const app = buildPublicApp(
      deps,
      { appOrigin: ORIGIN, secureCookies: false },
      {
        level: 'info',
        stream: { write: (s: string) => void lines.push(s) },
      },
    );
    const r = await login(app, { email: 'admin@example.com', password: 'pw-correct' });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: 'internal_error' });
    const logs = lines.join('');
    expect(logs).toContain('23505');
    expect(logs).toContain('/api/auth/login');
    expect(logs).not.toContain('LEAKMARKER');
    expect(logs).not.toContain('hunter2');
    expect(logs).not.toContain('pw-correct');
  });

  it('keeps 4xx for malformed requests', async () => {
    const app = buildPublicApp(fakeDeps(user()).deps, { appOrigin: ORIGIN, secureCookies: false });
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      payload: '{not json',
    });
    expect(r.statusCode).toBe(400);
  });
});
