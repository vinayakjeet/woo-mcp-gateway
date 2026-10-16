import { createHash, randomBytes } from 'node:crypto';
import { hashToken, oauthKeys, verifyAccessToken } from '@woo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, TEST_JWT_KEY, testApi, userWithSession } from './test-app.js';

const base = process.env.TEST_DATABASE_URL;
const RESOURCE = 'http://mcp.127.0.0.1.nip.io/mcp';
const REDIRECT = 'http://127.0.0.1:53682/callback';
const TOKEN = '/oauth/token';

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

describe.skipIf(!base)('POST /oauth/token (needs TEST_DATABASE_URL)', () => {
  let t: Awaited<ReturnType<typeof testApi>>;
  const logLines: string[] = [];
  let ipN = 0;
  let asha: { id: string; cookie: string };
  let clientId: string;
  let otherClientId: string;

  const nextIp = () => `192.0.2.${(ipN = (ipN % 250) + 1)}`;

  async function addClient(name: string, uris = [REDIRECT]): Promise<string> {
    const id = `dcr_${randomBytes(16).toString('base64url')}`;
    await t.pool.query(
      `insert into oauth_clients (client_id, name, redirect_uris) values ($1, $2, $3::jsonb)`,
      [id, name, JSON.stringify(uris)],
    );
    return id;
  }

  // Posts a form like a client does: no cookie, and no Origin unless the test asks for one.
  function token(
    fields: Record<string, string | string[]>,
    o: { ip?: string; type?: string; origin?: string; payload?: string } = {},
  ) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(fields))
      for (const one of Array.isArray(v) ? v : [v]) p.append(k, one);
    const headers: Record<string, string> = {
      'content-type': o.type ?? 'application/x-www-form-urlencoded',
      'x-forwarded-for': o.ip ?? nextIp(),
    };
    if (o.origin) headers.origin = o.origin;
    return t.app.inject({
      method: 'POST',
      url: TOKEN,
      headers,
      payload: o.payload ?? p.toString(),
    });
  }

  async function mintCode(
    o: {
      userId?: string;
      client?: string;
      redirectUri?: string;
      verifier?: string;
      ttl?: string;
      resource?: string;
      scope?: string;
    } = {},
  ) {
    const code = randomBytes(32).toString('base64url');
    const verifier = o.verifier ?? randomBytes(32).toString('base64url');
    await t.pool.query(
      `insert into oauth_codes
         (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + $8::interval)`,
      [
        hashToken(code),
        o.client ?? clientId,
        o.userId ?? asha.id,
        o.redirectUri ?? REDIRECT,
        challengeOf(verifier),
        o.resource ?? RESOURCE,
        o.scope ?? 'mcp:tools',
        o.ttl ?? '60 seconds',
      ],
    );
    return { code, verifier };
  }

  const codeFields = (
    c: { code: string; verifier: string },
    over: Record<string, string> = {},
  ) => ({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: c.code,
    redirect_uri: REDIRECT,
    code_verifier: c.verifier,
    ...over,
  });
  const refreshFields = (refresh: string, over: Record<string, string> = {}) => ({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refresh,
    ...over,
  });

  // A real first grant: a code from the table, redeemed over HTTP.
  async function firstGrant(userId = asha.id) {
    const res = await token(codeFields(await mintCode({ userId })));
    expect(res.statusCode).toBe(200);
    return res.json() as { access_token: string; refresh_token: string; scope: string };
  }
  async function mintRefresh(
    o: {
      userId?: string;
      client?: string;
      scope?: string;
      ttl?: string;
      revoked?: boolean;
      resource?: string;
    } = {},
  ) {
    const refresh = `urt_${randomBytes(32).toString('base64url')}`;
    await t.pool.query(
      `insert into oauth_refresh_tokens
         (token_hash, client_id, user_id, resource, scope, expires_at, revoked_at)
       values ($1, $2, $3, $4, $5, now() + $6::interval, $7)`,
      [
        hashToken(refresh),
        o.client ?? clientId,
        o.userId ?? asha.id,
        o.resource ?? RESOURCE,
        o.scope ?? 'mcp:tools',
        o.ttl ?? '30 days',
        o.revoked ? new Date() : null,
      ],
    );
    return refresh;
  }
  const rowOf = async (refresh: string) =>
    (
      await t.pool.query(
        `select id, client_id, user_id, resource, scope, revoked_at, replaced_by,
                extract(epoch from expires_at - now()) as ttl
           from oauth_refresh_tokens where token_hash = $1`,
        [hashToken(refresh)],
      )
    ).rows[0];
  // Moves a token's rotation time back. The grace window is measured in Postgres time, so a test
  // ages the row instead of waiting.
  const ageRotation = (refresh: string, seconds: number) =>
    t.pool.query(
      `update oauth_refresh_tokens set revoked_at = now() - $2::interval where token_hash = $1`,
      [hashToken(refresh), `${seconds} seconds`],
    );
  const rowsOf = async (userId: string) =>
    Number(
      (
        await t.pool.query('select count(*) as n from oauth_refresh_tokens where user_id = $1', [
          userId,
        ])
      ).rows[0].n,
    );
  const liveRefreshCount = async (userId: string) =>
    Number(
      (
        await t.pool.query(
          'select count(*) as n from oauth_refresh_tokens where user_id = $1 and revoked_at is null',
          [userId],
        )
      ).rows[0].n,
    );

  beforeAll(async () => {
    t = await testApi(
      'woo_oauth_token_test',
      {},
      { level: 'info', stream: { write: (s: string) => void logLines.push(s) } },
      { issuer: ORIGIN, jwtKey: TEST_JWT_KEY, resource: RESOURCE },
    );
    asha = await userWithSession(t.pool, 'asha-token@example.com', 'member');
    clientId = await addClient('Claude Code');
    otherClientId = await addClient('Other App');
  });
  afterAll(() => t.close());

  describe('authorization_code', () => {
    it('a right verifier gets access_token, Bearer, expires_in 900, scope and a urt_ refresh token, with no-store', async () => {
      const res = await token(codeFields(await mintCode()));
      expect(res.statusCode).toBe(200);
      const b = res.json();
      expect(b).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'mcp:tools' });
      expect(typeof b.access_token).toBe('string');
      expect(b.refresh_token).toMatch(/^urt_[A-Za-z0-9_-]{43}$/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers.pragma).toBe('no-cache');
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it("the access token verifies with the gateway's derived key and has aud = resource, sub, client_id", async () => {
      const b = (await token(codeFields(await mintCode()))).json();
      const keys = oauthKeys(TEST_JWT_KEY);
      const claims = verifyAccessToken(b.access_token, {
        publicKey: keys.publicKey,
        kid: keys.kid,
        iss: ORIGIN,
        aud: RESOURCE,
      });
      expect(claims).toMatchObject({
        iss: ORIGIN,
        aud: RESOURCE,
        sub: asha.id,
        client_id: clientId,
        scope: 'mcp:tools',
      });
      expect(claims.exp - claims.iat).toBe(900);
    });

    it('stores the refresh token hashed, bound to client, user, resource and scope, for 30 days', async () => {
      const b = await firstGrant();
      const row = await rowOf(b.refresh_token);
      expect(row).toMatchObject({
        client_id: clientId,
        user_id: asha.id,
        resource: RESOURCE,
        scope: 'mcp:tools',
        revoked_at: null,
        replaced_by: null,
      });
      expect(Number(row.ttl)).toBeGreaterThan(29.9 * 86400);
      expect(Number(row.ttl)).toBeLessThanOrEqual(30 * 86400);
      const plain = await t.pool.query('select 1 from oauth_refresh_tokens where token_hash = $1', [
        b.refresh_token,
      ]);
      expect(plain.rowCount).toBe(0);
    });

    it('works end to end from the consent page', async () => {
      const verifier = randomBytes(32).toString('base64url');
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challengeOf(verifier),
        code_challenge_method: 'S256',
        state: 'abc',
        resource: RESOURCE,
      });
      const page = await t.app.inject({
        method: 'GET',
        url: `/oauth/authorize?${q}`,
        headers: { cookie: asha.cookie },
      });
      const fields: Record<string, string> = {};
      for (const m of page.body.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g))
        fields[m[1]!] = m[2]!.replaceAll('&amp;', '&');
      const done = await t.app.inject({
        method: 'POST',
        url: '/oauth/authorize',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: ORIGIN,
          cookie: asha.cookie,
        },
        payload: new URLSearchParams({ ...fields, decision: 'approve' }).toString(),
      });
      expect(done.statusCode).toBe(303);
      const code = new URL(String(done.headers.location)).searchParams.get('code')!;
      const res = await token(codeFields({ code, verifier }, { resource: RESOURCE }));
      expect(res.statusCode).toBe(200);
      expect(res.json().refresh_token).toMatch(/^urt_/);
    });

    it('a wrong verifier, a wrong redirect_uri or another client_id is invalid_grant', async () => {
      const cases: Array<Record<string, string>> = [
        { code_verifier: randomBytes(32).toString('base64url') },
        { redirect_uri: 'http://127.0.0.1:53683/callback' },
        { redirect_uri: `${REDIRECT}/` },
        { client_id: otherClientId },
      ];
      for (const over of cases) {
        const res = await token(codeFields(await mintCode(), over));
        expect(res.statusCode, JSON.stringify(over)).toBe(400);
        expect(res.json().error).toBe('invalid_grant');
        expect(res.json().access_token).toBeUndefined();
      }
    });

    it('a failed attempt burns the code', async () => {
      const c = await mintCode();
      const bad = await token(
        codeFields(c, { code_verifier: randomBytes(32).toString('base64url') }),
      );
      expect(bad.json().error).toBe('invalid_grant');
      const good = await token(codeFields(c));
      expect(good.statusCode).toBe(400);
      expect(good.json().error).toBe('invalid_grant');
    });

    it('a foreign resource is invalid_target, and the code can still be used', async () => {
      const c = await mintCode();
      const res = await token(codeFields(c, { resource: 'https://evil.example/mcp' }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_target');
      expect((await token(codeFields(c, { resource: RESOURCE }))).statusCode).toBe(200);
    });

    it('a resource that differs from the one the code was issued for is invalid_target', async () => {
      const c = await mintCode({ resource: 'http://mcp.old.example/mcp' });
      const res = await token(codeFields(c, { resource: RESOURCE }));
      expect(res.json().error).toBe('invalid_target');
    });

    it('a code is redeemed once: two parallel redemptions give one 200 and one invalid_grant', async () => {
      const c = await mintCode();
      const [a, b] = await Promise.all([token(codeFields(c)), token(codeFields(c))]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
      const failed = a.statusCode === 400 ? a : b;
      expect(failed.json().error).toBe('invalid_grant');
      const rows = await t.pool.query(
        `select count(*) as n from oauth_refresh_tokens where client_id = $1 and created_at > now() - interval '5 seconds' and user_id = $2`,
        [clientId, asha.id],
      );
      expect(Number(rows.rows[0].n)).toBeGreaterThanOrEqual(1);
    });

    it('the same code again is invalid_grant', async () => {
      const c = await mintCode();
      expect((await token(codeFields(c))).statusCode).toBe(200);
      const again = await token(codeFields(c));
      expect(again.statusCode).toBe(400);
      expect(again.json().error).toBe('invalid_grant');
    });

    it('an expired code is invalid_grant', async () => {
      const res = await token(codeFields(await mintCode({ ttl: '-1 second' })));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
    });

    it('a code for a disabled user is invalid_grant', async () => {
      const gone = await userWithSession(t.pool, 'gone-token@example.com', 'member');
      const c = await mintCode({ userId: gone.id });
      await t.pool.query(`update users set status = 'disabled' where id = $1`, [gone.id]);
      const res = await token(codeFields(c));
      expect(res.json().error).toBe('invalid_grant');
      expect(await liveRefreshCount(gone.id)).toBe(0);
    });

    it('an unknown or missing code is invalid_grant', async () => {
      const v = randomBytes(32).toString('base64url');
      const res = await token(
        codeFields({ code: randomBytes(32).toString('base64url'), verifier: v }),
      );
      expect(res.json().error).toBe('invalid_grant');
    });

    it.each([
      ['code', 'invalid_request'],
      ['redirect_uri', 'invalid_request'],
      ['code_verifier', 'invalid_request'],
      ['client_id', 'invalid_request'],
    ])('a missing %s is %s', async (field, error) => {
      const fields: Record<string, string> = codeFields(await mintCode());
      delete fields[field];
      const res = await token(fields);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(error);
    });

    it('a verifier outside 43 to 128 unreserved characters is invalid_request, and the code survives', async () => {
      const c = await mintCode();
      for (const bad of [
        'short',
        'a'.repeat(42),
        'a'.repeat(129),
        `${'a'.repeat(42)}!`,
        `${'a'.repeat(42)} `,
      ]) {
        const res = await token(codeFields(c, { code_verifier: bad }));
        expect(res.statusCode, bad).toBe(400);
        expect(res.json().error).toBe('invalid_request');
      }
      expect((await token(codeFields(c))).statusCode).toBe(200);
    });

    it('accepts a verifier of 43 and of 128 characters', async () => {
      for (const len of [43, 128]) {
        const verifier = 'v'.repeat(len);
        expect(
          (await token(codeFields(await mintCode({ verifier }), { code_verifier: verifier })))
            .statusCode,
        ).toBe(200);
      }
    });

    it('a repeated parameter is invalid_request', async () => {
      const c = await mintCode();
      const res = await token({ ...codeFields(c), code: [c.code, c.code] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
      expect((await token(codeFields(c))).statusCode).toBe(200);
    });

    it('an unknown client_id is 401 invalid_client', async () => {
      const res = await token(codeFields(await mintCode(), { client_id: 'dcr_doesnotexist' }));
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('invalid_client');
    });
  });

  describe('request shape', () => {
    it('a JSON body is invalid_request', async () => {
      const c = await mintCode();
      const res = await token(codeFields(c), {
        type: 'application/json',
        payload: JSON.stringify(codeFields(c)),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
      expect(res.headers['cache-control']).toBe('no-store');
      expect((await token(codeFields(c))).statusCode).toBe(200);
    });

    it('plain text and an empty body are invalid_request', async () => {
      for (const o of [
        { type: 'text/plain', payload: 'grant_type=refresh_token' },
        { payload: '' },
      ]) {
        const res = await token({}, o);
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('invalid_request');
      }
    });

    it('an unknown grant_type is unsupported_grant_type, a missing one invalid_request', async () => {
      for (const g of [
        'password',
        'client_credentials',
        'urn:ietf:params:oauth:grant-type:device_code',
        '',
      ]) {
        const res = await token({ grant_type: g, client_id: clientId });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('unsupported_grant_type');
      }
      const none = await token({ client_id: clientId });
      expect(none.json().error).toBe('invalid_request');
    });

    it('a body over 16 KiB is refused', async () => {
      const res = await token({ grant_type: 'refresh_token', junk: 'x'.repeat(20_000) });
      expect(res.statusCode).toBe(413);
      expect(res.json().error).toBe('invalid_request');
    });

    it('answers a foreign Origin and no Origin alike, with open CORS and no credentials', async () => {
      const c = await mintCode();
      const foreign = await token(codeFields(c), { origin: 'http://localhost:6274' });
      expect(foreign.statusCode).toBe(200);
      expect(foreign.headers['access-control-allow-origin']).toBe('*');
      expect(foreign.headers['access-control-allow-credentials']).toBeUndefined();
      const err = await token({ grant_type: 'nope' }, { origin: 'http://localhost:6274' });
      expect(err.headers['access-control-allow-origin']).toBe('*');
      expect(err.headers['cache-control']).toBe('no-store');
      expect(err.headers.pragma).toBe('no-cache');
    });

    it('does not read a session cookie', async () => {
      const c = await mintCode();
      const res = await t.app.inject({
        method: 'POST',
        url: TOKEN,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'sid=not-a-real-session',
          'x-forwarded-for': nextIp(),
        },
        payload: new URLSearchParams(codeFields(c)).toString(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('OPTIONS answers the CORS preflight', async () => {
      const res = await t.app.inject({
        method: 'OPTIONS',
        url: TOKEN,
        headers: { origin: 'http://localhost:6274', 'access-control-request-method': 'POST' },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-headers']).toContain('content-type');
    });

    it('the 31st token request from one IP in a minute is 429 with Retry-After, and another IP is not limited', async () => {
      const ip = '198.51.100.77';
      for (let i = 0; i < 30; i++) {
        const res = await token({ grant_type: 'nope' }, { ip });
        expect(res.statusCode).toBe(400);
      }
      const limited = await token({ grant_type: 'nope' }, { ip });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: 'temporarily_unavailable' });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.headers['access-control-allow-origin']).toBe('*');
      expect(limited.headers['cache-control']).toBe('no-store');
      const c = await mintCode();
      const blocked = await token(codeFields(c), { ip });
      expect(blocked.statusCode).toBe(429);
      expect((await token(codeFields(c), { ip: '198.51.100.78' })).statusCode).toBe(200);
    });
  });

  describe('refresh_token', () => {
    it('refresh rotates: the old token is revoked with replaced_by set and the new one works', async () => {
      const first = await firstGrant();
      const res = await token(refreshFields(first.refresh_token));
      expect(res.statusCode).toBe(200);
      const next = res.json();
      expect(next).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'mcp:tools' });
      expect(next.refresh_token).toMatch(/^urt_/);
      expect(next.refresh_token).not.toBe(first.refresh_token);
      expect(next.access_token).not.toBe(first.access_token);
      const oldRow = await rowOf(first.refresh_token);
      const newRow = await rowOf(next.refresh_token);
      expect(oldRow.revoked_at).not.toBeNull();
      expect(oldRow.replaced_by).toBe(newRow.id);
      expect(newRow).toMatchObject({
        client_id: clientId,
        user_id: asha.id,
        revoked_at: null,
        replaced_by: null,
      });
      expect(Number(newRow.ttl)).toBeGreaterThan(29.9 * 86400);
      expect((await token(refreshFields(next.refresh_token))).statusCode).toBe(200);
    });

    it('the refreshed access token verifies and names the same subject and client', async () => {
      const first = await firstGrant();
      const next = (await token(refreshFields(first.refresh_token))).json();
      const keys = oauthKeys(TEST_JWT_KEY);
      expect(
        verifyAccessToken(next.access_token, {
          publicKey: keys.publicKey,
          kid: keys.kid,
          iss: ORIGIN,
          aud: RESOURCE,
        }),
      ).toMatchObject({ sub: asha.id, client_id: clientId });
    });

    it('reusing the first token of a chain of four answers invalid_grant and revokes every row in it, including the live one', async () => {
      const t1 = (await firstGrant()).refresh_token;
      const t2 = (await token(refreshFields(t1))).json().refresh_token as string;
      const t3 = (await token(refreshFields(t2))).json().refresh_token as string;
      const t4 = (await token(refreshFields(t3))).json().refresh_token as string;
      expect((await rowOf(t4)).revoked_at).toBeNull();
      const reuse = await token(refreshFields(t1));
      expect(reuse.statusCode).toBe(400);
      expect(reuse.json().error).toBe('invalid_grant');
      for (const old of [t1, t2, t3, t4]) expect((await rowOf(old)).revoked_at).not.toBeNull();
      const live = await token(refreshFields(t4));
      expect(live.statusCode).toBe(400);
      expect(live.json().error).toBe('invalid_grant');
    });

    it('reuse of a middle token revokes what came after it and leaves other grants alone', async () => {
      const other = await userWithSession(t.pool, 'bystander-token@example.com', 'member');
      const bystander = (await firstGrant(other.id)).refresh_token;
      const t1 = (await firstGrant()).refresh_token;
      const t2 = (await token(refreshFields(t1))).json().refresh_token as string;
      const t3 = (await token(refreshFields(t2))).json().refresh_token as string;
      await ageRotation(t2, 31);
      await token(refreshFields(t2));
      expect((await rowOf(t3)).revoked_at).not.toBeNull();
      expect((await rowOf(bystander)).revoked_at).toBeNull();
      expect((await token(refreshFields(bystander))).statusCode).toBe(200);
    });

    it('a reused token does not revoke a separate grant of the same user and client', async () => {
      const a = (await firstGrant()).refresh_token;
      const b = (await firstGrant()).refresh_token;
      const a2 = (await token(refreshFields(a))).json().refresh_token as string;
      await ageRotation(a, 31);
      await token(refreshFields(a));
      expect((await rowOf(a2)).revoked_at).not.toBeNull();
      expect((await rowOf(b)).revoked_at).toBeNull();
    });

    describe('reuse grace window of 30 s', () => {
      const fresh = async (email: string) => {
        const u = await userWithSession(t.pool, email, 'member');
        return { u, first: await firstGrant(u.id) };
      };
      const pairOf = (res: { json: () => unknown }) =>
        res.json() as { access_token: string; refresh_token: string; scope: string };

      it('two concurrent refreshes of one token both succeed with the same pair and rotate once', async () => {
        const { u, first } = await fresh('grace-parallel@example.com');
        const res = await Promise.all(
          [1, 2, 3, 4].map(() => token(refreshFields(first.refresh_token))),
        );
        expect(res.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
        const pairs = res.map(pairOf);
        for (const p of pairs.slice(1)) expect(p).toEqual(pairs[0]);
        expect(await rowsOf(u.id)).toBe(2);
        const head = await rowOf(pairs[0]!.refresh_token);
        expect(head.revoked_at).toBeNull();
        expect((await rowOf(first.refresh_token)).replaced_by).toBe(head.id);
        expect((await token(refreshFields(pairs[0]!.refresh_token))).statusCode).toBe(200);
      });

      it('a replay 29 s after the rotation returns the same pair again and changes nothing', async () => {
        const { u, first } = await fresh('grace-29s@example.com');
        const a = pairOf(await token(refreshFields(first.refresh_token)));
        await ageRotation(first.refresh_token, 29);
        const b = await token(refreshFields(first.refresh_token));
        expect(b.statusCode).toBe(200);
        expect(pairOf(b)).toEqual(a);
        expect(b.headers['cache-control']).toBe('no-store');
        expect(await rowsOf(u.id)).toBe(2);
        const head = await rowOf(a.refresh_token);
        expect(head.revoked_at).toBeNull();
        const keys = oauthKeys(TEST_JWT_KEY);
        const claims = verifyAccessToken(a.access_token, {
          publicKey: keys.publicKey,
          kid: keys.kid,
          iss: ORIGIN,
          aud: RESOURCE,
        });
        expect(claims).toMatchObject({ sub: u.id, client_id: clientId, jti: head.id });
      });

      it('a reuse 31 s after the rotation is invalid_grant and revokes the whole grant', async () => {
        const { u, first } = await fresh('grace-31s@example.com');
        const a = pairOf(await token(refreshFields(first.refresh_token)));
        await ageRotation(first.refresh_token, 31);
        const reuse = await token(refreshFields(first.refresh_token));
        expect(reuse.statusCode).toBe(400);
        expect(reuse.json().error).toBe('invalid_grant');
        expect(await liveRefreshCount(u.id)).toBe(0);
        expect((await rowOf(a.refresh_token)).revoked_at).not.toBeNull();
        expect((await token(refreshFields(a.refresh_token))).json().error).toBe('invalid_grant');
      });

      it('a token two generations old is a reuse even inside the 30 s, and revokes the live token', async () => {
        const { u, first } = await fresh('grace-two-gen@example.com');
        const t2 = pairOf(await token(refreshFields(first.refresh_token)));
        const t3 = pairOf(await token(refreshFields(t2.refresh_token)));
        expect((await rowOf(t3.refresh_token)).revoked_at).toBeNull();
        const reuse = await token(refreshFields(first.refresh_token));
        expect(reuse.statusCode).toBe(400);
        expect(reuse.json().error).toBe('invalid_grant');
        expect(await liveRefreshCount(u.id)).toBe(0);
        expect((await token(refreshFields(t3.refresh_token))).json().error).toBe('invalid_grant');
      });

      it('the previous token of the live one is still inside the window', async () => {
        const { first } = await fresh('grace-middle@example.com');
        const t2 = pairOf(await token(refreshFields(first.refresh_token)));
        const t3 = pairOf(await token(refreshFields(t2.refresh_token)));
        const again = await token(refreshFields(t2.refresh_token));
        expect(again.statusCode).toBe(200);
        expect(pairOf(again)).toEqual(t3);
      });

      it('inside the window a different client_id is a reuse and revokes the chain', async () => {
        const { u, first } = await fresh('grace-client@example.com');
        await token(refreshFields(first.refresh_token));
        const res = await token(refreshFields(first.refresh_token, { client_id: otherClientId }));
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('invalid_grant');
        expect(await liveRefreshCount(u.id)).toBe(0);
      });

      it('a replay never revives a grant that was revoked after the rotation', async () => {
        const { u, first } = await fresh('grace-revoked@example.com');
        const a = pairOf(await token(refreshFields(first.refresh_token)));
        await t.pool.query(
          'update oauth_refresh_tokens set revoked_at = now() where token_hash = $1',
          [hashToken(a.refresh_token)],
        );
        const res = await token(refreshFields(first.refresh_token));
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('invalid_grant');
        expect(await liveRefreshCount(u.id)).toBe(0);
      });

      it('a replay for a disabled user is invalid_grant and returns no token', async () => {
        const { u, first } = await fresh('grace-disabled@example.com');
        await token(refreshFields(first.refresh_token));
        await t.pool.query(`update users set status = 'disabled' where id = $1`, [u.id]);
        const res = await token(refreshFields(first.refresh_token));
        expect(res.statusCode).toBe(400);
        expect(res.json()).not.toHaveProperty('refresh_token');
        expect(res.json().error).toBe('invalid_grant');
      });

      it('a successor that is not the derived one is never returned', async () => {
        const parent = await mintRefresh({ revoked: true });
        const stranger = await mintRefresh();
        await t.pool.query(
          'update oauth_refresh_tokens set replaced_by = (select id from oauth_refresh_tokens where token_hash = $2) where token_hash = $1',
          [hashToken(parent), hashToken(stranger)],
        );
        const res = await token(refreshFields(parent));
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('invalid_grant');
        expect((await rowOf(stranger)).revoked_at).not.toBeNull();
      });

      it('a replay can narrow to what the first answer had, never widen it', async () => {
        const wide = await mintRefresh({ scope: 'mcp:tools extra:read' });
        const a = pairOf(await token(refreshFields(wide, { scope: 'mcp:tools' })));
        expect(a.scope).toBe('mcp:tools');
        const same = await token(refreshFields(wide, { scope: 'mcp:tools' }));
        expect(same.statusCode).toBe(200);
        expect(pairOf(same)).toEqual(a);
        const wider = await token(refreshFields(wide, { scope: 'mcp:tools extra:read' }));
        expect(wider.statusCode).toBe(400);
        expect(wider.json().error).toBe('invalid_grant');
        const foreign = await token(refreshFields(wide, { scope: 'other:scope' }));
        expect(foreign.json().error).toBe('invalid_scope');
        expect((await rowOf(a.refresh_token)).revoked_at).toBeNull();
      });
    });

    it('refresh can narrow scope, never widen', async () => {
      const wide = await mintRefresh({ scope: 'mcp:tools extra:read' });
      const narrowed = await token(refreshFields(wide, { scope: 'mcp:tools' }));
      expect(narrowed.statusCode).toBe(200);
      expect(narrowed.json().scope).toBe('mcp:tools');
      const next = narrowed.json().refresh_token as string;
      expect((await rowOf(next)).scope).toBe('mcp:tools');
      const widen = await token(refreshFields(next, { scope: 'mcp:tools extra:read' }));
      expect(widen.statusCode).toBe(400);
      expect(widen.json().error).toBe('invalid_scope');
      expect((await rowOf(next)).revoked_at).toBeNull();
    });

    it('an empty scope is invalid_scope, not a token with no scope', async () => {
      const r = await mintRefresh();
      for (const scope of ['', ' ']) {
        const res = await token(refreshFields(r, { scope }));
        expect(res.statusCode, JSON.stringify(scope)).toBe(400);
        expect(res.json().error).toBe('invalid_scope');
      }
      expect((await rowOf(r)).revoked_at).toBeNull();
    });

    it('with no scope it keeps the scope of the token', async () => {
      const wide = await mintRefresh({ scope: 'mcp:tools extra:read' });
      expect((await token(refreshFields(wide))).json().scope).toBe('mcp:tools extra:read');
    });

    it('a token issued for another resource is invalid_target and stays unspent', async () => {
      const r = await mintRefresh({ resource: 'http://mcp.old.example/mcp' });
      const res = await token(refreshFields(r));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_target');
      expect((await rowOf(r)).revoked_at).toBeNull();
    });

    it('a foreign resource is invalid_target and leaves the token usable', async () => {
      const r = await mintRefresh();
      const res = await token(refreshFields(r, { resource: 'https://evil.example/mcp' }));
      expect(res.json().error).toBe('invalid_target');
      expect((await rowOf(r)).revoked_at).toBeNull();
      expect((await token(refreshFields(r, { resource: RESOURCE }))).statusCode).toBe(200);
    });

    it("a disabled user's refresh is invalid_grant", async () => {
      const gone = await userWithSession(t.pool, 'gone-refresh@example.com', 'member');
      const r = await mintRefresh({ userId: gone.id });
      await t.pool.query(`update users set status = 'disabled' where id = $1`, [gone.id]);
      const res = await token(refreshFields(r));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
    });

    it('an expired token, an unknown token and a malformed token are invalid_grant', async () => {
      const expired = await mintRefresh({ ttl: '-1 second' });
      for (const r of [
        expired,
        `urt_${randomBytes(32).toString('base64url')}`,
        'urt_short',
        'not-a-token',
        '',
      ]) {
        const res = await token(refreshFields(r));
        expect(res.statusCode, r).toBe(400);
        expect(res.json().error).toBe('invalid_grant');
      }
    });

    it('a token revoked with no successor is invalid_grant and touches nothing else', async () => {
      const live = (await firstGrant()).refresh_token;
      const revoked = await mintRefresh({ revoked: true });
      const res = await token(refreshFields(revoked));
      expect(res.json().error).toBe('invalid_grant');
      expect((await rowOf(live)).revoked_at).toBeNull();
    });

    it('a live token presented by another client is invalid_grant and stays usable by its own', async () => {
      const r = await mintRefresh();
      const res = await token(refreshFields(r, { client_id: otherClientId }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
      expect((await rowOf(r)).revoked_at).toBeNull();
      expect((await token(refreshFields(r))).statusCode).toBe(200);
    });

    it('a missing refresh_token is invalid_request, an unknown client_id is 401 invalid_client', async () => {
      expect((await token({ grant_type: 'refresh_token', client_id: clientId })).json().error).toBe(
        'invalid_request',
      );
      const res = await token(
        refreshFields(await mintRefresh(), { client_id: 'dcr_doesnotexist' }),
      );
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('invalid_client');
    });
  });

  it('no token, code, verifier or refresh token appears in the captured log output', async () => {
    const c = await mintCode();
    const ok = (await token(codeFields(c))).json();
    const secrets = [c.code, c.verifier, ok.access_token as string, ok.refresh_token as string];
    const rotated = (await token(refreshFields(ok.refresh_token))).json();
    secrets.push(rotated.access_token, rotated.refresh_token);
    const bad = await mintCode();
    secrets.push(bad.code, bad.verifier);
    await token(codeFields(bad, { code_verifier: 'z'.repeat(50) }));
    await token(refreshFields(ok.refresh_token));
    const old = (await firstGrant()).refresh_token;
    const newer = (await token(refreshFields(old))).json();
    secrets.push(old, newer.access_token, newer.refresh_token);
    await ageRotation(old, 31);
    await token(refreshFields(old));
    await token(codeFields(await mintCode(), { client_id: 'dcr_doesnotexist' }));
    const json = await mintCode();
    secrets.push(json.code, json.verifier);
    await token(codeFields(json), {
      type: 'application/json',
      payload: JSON.stringify(codeFields(json)),
    });
    for (let i = 0; i < 32; i++) await token({ grant_type: 'nope' }, { ip: '198.51.100.200' });
    const log = logLines.join('\n');
    expect(log.length).toBeGreaterThan(0);
    for (const s of secrets) expect(log, s.slice(0, 8)).not.toContain(s);
    expect(log).not.toContain('urt_');
    expect(log).not.toContain('code_verifier');
  });
});
