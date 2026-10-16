import { createHmac } from 'node:crypto';
import { generateApiKey, oauthKeys, signAccessToken, signAgentJwt } from '@woo/core';
import { schema } from '@woo/core/db';
import { and, eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Authenticator } from './auth.js';
import { migratedDatabase, TEST_DATABASE_URL } from './test-db.js';
import { quietLog } from './test-helpers.js';
import type { Db } from './types.js';

const PEPPER = 'test-pepper';
const JWT_KEY = 'test-jwt-key';
const AUD = 'http://mcp.test/mcp';
const ISS = 'http://app.test';

describe.skipIf(!TEST_DATABASE_URL)('Authenticator', () => {
  let pool: pg.Pool;
  let db: Db;
  let adminId: string;
  let disabledId: string;
  let t = Date.now();
  const now = () => t;
  const auth = () =>
    new Authenticator({ db, pepper: PEPPER, jwtKey: JWT_KEY, audience: AUD, log: quietLog, now });

  async function addKey(userId: string, over: Partial<typeof schema.apiKeys.$inferInsert> = {}) {
    const k = generateApiKey(PEPPER);
    const [row] = await db
      .insert(schema.apiKeys)
      .values({ userId, name: 'k', prefix: k.prefix, secretHash: k.secretHash, ...over })
      .returning({ id: schema.apiKeys.id });
    return { key: k.key, id: row!.id };
  }

  const lastUsed = async (id: string) =>
    (
      await db
        .select({ v: schema.apiKeys.lastUsedAt })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.id, id))
    )[0]?.v ?? null;

  beforeAll(async () => {
    ({ pool, db } = await migratedDatabase('woo_gw_auth_test'));
    const [a] = await db
      .insert(schema.users)
      .values({ email: 'admin@example.com', role: 'admin', status: 'active' })
      .returning({ id: schema.users.id });
    const [d] = await db
      .insert(schema.users)
      .values({ email: 'gone@example.com', status: 'disabled' })
      .returning({ id: schema.users.id });
    adminId = a!.id;
    disabledId = d!.id;
  });
  afterAll(() => pool.end());
  beforeEach(() => {
    t = Date.now();
  });

  it('accepts a valid key', async () => {
    const { key, id } = await addKey(adminId);
    expect(await auth().authenticate(`Bearer ${key}`)).toEqual({
      userId: adminId,
      email: 'admin@example.com',
      role: 'admin',
      via: 'api_key',
      apiKeyId: id,
      toolMode: 'auto',
      rateLimitPerMin: null,
    });
  });

  it('carries rate_limit_per_min from the cached key row', async () => {
    const { key, id } = await addKey(adminId, { rateLimitPerMin: 7 });
    const a = auth();
    expect((await a.authenticate(`Bearer ${key}`))?.rateLimitPerMin).toBe(7);
    // Cached for the TTL: a change shows up only after it, like tool_mode.
    await db.update(schema.apiKeys).set({ rateLimitPerMin: 9 }).where(eq(schema.apiKeys.id, id));
    expect((await a.authenticate(`Bearer ${key}`))?.rateLimitPerMin).toBe(7);
  });

  it("carries the key's tool_mode on the principal", async () => {
    const { key } = await addKey(adminId, { toolMode: 'search' });
    expect((await auth().authenticate(`Bearer ${key}`))?.toolMode).toBe('search');
  });

  it('keeps a cached mode until the cache entry expires', async () => {
    const { key, id } = await addKey(adminId, { toolMode: 'search' });
    const a = auth();
    expect((await a.authenticate(`Bearer ${key}`))?.toolMode).toBe('search');
    await db.update(schema.apiKeys).set({ toolMode: 'full' }).where(eq(schema.apiKeys.id, id));
    t += 9_000;
    expect((await a.authenticate(`Bearer ${key}`))?.toolMode).toBe('search');
    t += 1_000;
    expect((await a.authenticate(`Bearer ${key}`))?.toolMode).toBe('full');
  });

  it('rejects a wrong secret with a known prefix, cached or not', async () => {
    const { key } = await addKey(adminId);
    const wrong = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
    const a = auth();
    expect(await a.authenticate(`Bearer ${wrong}`)).toBeNull();
    expect(await a.authenticate(`Bearer ${key}`)).not.toBeNull();
    expect(await a.authenticate(`Bearer ${wrong}`)).toBeNull();
  });

  it('rejects missing, malformed and non-Bearer headers', async () => {
    const a = auth();
    for (const h of [undefined, '', 'Basic abc', 'Bearer', 'Bearer urk_short', 'Bearer a.b.c']) {
      expect(await a.authenticate(h)).toBeNull();
    }
  });

  it('rejects expired keys and disabled users', async () => {
    const expired = await addKey(adminId, { expiresAt: new Date(t - 1000) });
    const disabled = await addKey(disabledId);
    expect(await auth().authenticate(`Bearer ${expired.key}`)).toBeNull();
    expect(await auth().authenticate(`Bearer ${disabled.key}`)).toBeNull();
  });

  it('drops a revoked key from the cache at once on purge', async () => {
    const { key, id } = await addKey(adminId);
    const a = auth();
    expect(await a.authenticate(`Bearer ${key}`)).not.toBeNull();
    await db.update(schema.apiKeys).set({ revokedAt: new Date() }).where(eq(schema.apiKeys.id, id));
    // Without the NOTIFY the cached entry still answers: this is the 10 s window the purge closes.
    expect(await a.authenticate(`Bearer ${key}`)).not.toBeNull();
    a.purge(id);
    expect(await a.authenticate(`Bearer ${key}`)).toBeNull();
  });

  it('reads the database again after 10 s', async () => {
    const { key, id } = await addKey(adminId);
    const a = auth();
    expect(await a.authenticate(`Bearer ${key}`)).not.toBeNull();
    await db.update(schema.apiKeys).set({ revokedAt: new Date() }).where(eq(schema.apiKeys.id, id));
    t += 10_000;
    expect(await a.authenticate(`Bearer ${key}`)).toBeNull();
  });

  it('writes last_used_at at most once a minute', async () => {
    const { key, id } = await addKey(adminId);
    const a = auth();
    await a.authenticate(`Bearer ${key}`);
    await vi.waitFor(async () => expect(await lastUsed(id)).not.toBeNull());
    const first = (await lastUsed(id))!.getTime();
    t += 30_000;
    await a.authenticate(`Bearer ${key}`);
    await new Promise((r) => setTimeout(r, 100));
    expect((await lastUsed(id))!.getTime()).toBe(first);
    t += 31_000;
    await a.authenticate(`Bearer ${key}`);
    await vi.waitFor(async () => expect((await lastUsed(id))!.getTime()).toBeGreaterThan(first));
  });

  it('remembers an unknown prefix for 5 s, then asks the database again', async () => {
    const k = generateApiKey(PEPPER);
    const a = auth();
    expect(await a.authenticate(`Bearer ${k.key}`)).toBeNull();
    await db
      .insert(schema.apiKeys)
      .values({ userId: adminId, name: 'late', prefix: k.prefix, secretHash: k.secretHash });
    t += 4_999;
    expect(await a.authenticate(`Bearer ${k.key}`)).toBeNull();
    t += 1;
    expect(await a.authenticate(`Bearer ${k.key}`)).not.toBeNull();
  });

  it('keeps at most 1000 unknown prefixes', async () => {
    const a = auth();
    for (let i = 0; i < 1001; i++) await a.authenticate(`Bearer ${generateApiKey(PEPPER).key}`);
    expect(a.cacheSizes().negative).toBe(1000);
  });

  it('prunes expired cache and last_used entries', async () => {
    const { key } = await addKey(adminId);
    const a = auth();
    await a.authenticate(`Bearer ${key}`);
    expect(a.cacheSizes()).toMatchObject({ positive: 1, touched: 1 });
    t += 61_000;
    await a.authenticate(`Bearer ${generateApiKey(PEPPER).key}`);
    expect(a.cacheSizes()).toEqual({ positive: 0, negative: 1, touched: 0 });
  });

  it('accepts an agent token for an active user', async () => {
    const token = signAgentJwt({
      key: JWT_KEY,
      userId: adminId,
      audience: AUD,
      now: Math.floor(t / 1000),
    });
    expect(await auth().authenticate(`Bearer ${token}`)).toEqual({
      userId: adminId,
      email: 'admin@example.com',
      role: 'admin',
      via: 'agent',
      apiKeyId: null,
      toolMode: 'auto',
      rateLimitPerMin: null,
    });
  });

  it('rejects agent tokens with the wrong key, typ or audience, a disabled user or a non-uuid subject', async () => {
    const s = Math.floor(t / 1000);
    const a = auth();
    const otherKey = signAgentJwt({ key: 'other-key', userId: adminId, audience: AUD, now: s });
    const typJwt = otherKey.replace(
      /^[^.]+/,
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    );
    expect(await a.authenticate(`Bearer ${otherKey}`)).toBeNull();
    expect(await a.authenticate(`Bearer ${typJwt}`)).toBeNull();
    expect(
      await a.authenticate(
        `Bearer ${signAgentJwt({ key: JWT_KEY, userId: adminId, audience: 'http://other', now: s })}`,
      ),
    ).toBeNull();
    expect(
      await a.authenticate(
        `Bearer ${signAgentJwt({ key: JWT_KEY, userId: disabledId, audience: AUD, now: s })}`,
      ),
    ).toBeNull();
    expect(
      await a.authenticate(
        `Bearer ${signAgentJwt({ key: JWT_KEY, userId: 'not-a-uuid', audience: AUD, now: s })}`,
      ),
    ).toBeNull();
  });

  describe('OAuth access tokens', () => {
    const keys = oauthKeys(JWT_KEY);
    const oauthAuth = () =>
      new Authenticator({
        db,
        pepper: PEPPER,
        jwtKey: JWT_KEY,
        audience: AUD,
        oauthIssuer: ISS,
        log: quietLog,
        now,
      });
    const token = (
      o: { sub?: string; iss?: string; aud?: string; at?: number; client?: string } = {},
    ) =>
      signAccessToken({
        keys,
        iss: o.iss ?? ISS,
        aud: o.aud ?? AUD,
        sub: o.sub ?? adminId,
        clientId: o.client ?? 'dcr_test',
        scope: 'mcp:tools',
        now: Math.floor((o.at ?? t) / 1000),
      });
    // An access token only counts while its user has approved its client (decision D2).
    const approve = async (userId: string, clientId: string, at: number) => {
      await db
        .insert(schema.oauthConsents)
        .values({ userId, clientId, scope: 'mcp:tools', createdAt: new Date(at) })
        .onConflictDoUpdate({
          target: [schema.oauthConsents.userId, schema.oauthConsents.clientId],
          set: { createdAt: new Date(at) },
        });
    };
    const revokeConsent = (userId: string, clientId: string) =>
      db
        .delete(schema.oauthConsents)
        .where(
          and(eq(schema.oauthConsents.userId, userId), eq(schema.oauthConsents.clientId, clientId)),
        );
    beforeEach(async () => {
      await db.delete(schema.oauthConsents);
      await approve(adminId, 'dcr_test', t - 3_600_000);
    });
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const claims = () => ({
      iss: ISS,
      aud: AUD,
      sub: adminId,
      client_id: 'dcr_test',
      scope: 'mcp:tools',
      iat: Math.floor(t / 1000),
      exp: Math.floor(t / 1000) + 900,
      jti: 'j',
    });

    it('an at+jwt for an active user is a principal via oauth, tool mode auto, no key id, no own limit', async () => {
      expect(await oauthAuth().authenticate(`Bearer ${token()}`)).toEqual({
        userId: adminId,
        email: 'admin@example.com',
        role: 'admin',
        via: 'oauth',
        apiKeyId: null,
        toolMode: 'auto',
        rateLimitPerMin: null,
      });
    });

    it('reads the role from the users table on every request', async () => {
      const [m] = await db
        .insert(schema.users)
        .values({ email: 'oauth-member@example.com', role: 'member', status: 'active' })
        .returning({ id: schema.users.id });
      await approve(m!.id, 'dcr_test', t - 3_600_000);
      const a = oauthAuth();
      expect(await a.authenticate(`Bearer ${token({ sub: m!.id })}`)).toMatchObject({
        role: 'member',
      });
      await db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, m!.id));
      expect(await a.authenticate(`Bearer ${token({ sub: m!.id })}`)).toMatchObject({
        role: 'admin',
      });
    });

    it("a disabled user's token and a token for an unknown user are refused", async () => {
      await approve(disabledId, 'dcr_test', t - 3_600_000);
      const a = oauthAuth();
      expect(await a.authenticate(`Bearer ${token({ sub: disabledId })}`)).toBeNull();
      expect(
        await a.authenticate(`Bearer ${token({ sub: '00000000-0000-4000-8000-0000000000ff' })}`),
      ).toBeNull();
    });

    it('a token for another audience or issuer is refused', async () => {
      const a = oauthAuth();
      expect(await a.authenticate(`Bearer ${token({ aud: 'http://other.test/mcp' })}`)).toBeNull();
      expect(await a.authenticate(`Bearer ${token({ iss: 'http://evil.test' })}`)).toBeNull();
    });

    it('an expired at+jwt is refused, and one inside the 30 s skew is accepted', async () => {
      // exp is iat + 900 s. 30 s past exp is refused, 29 s past is inside the skew.
      const a = oauthAuth();
      expect(await a.authenticate(`Bearer ${token({ at: t - 930_000 })}`)).toBeNull();
      expect(await a.authenticate(`Bearer ${token({ at: t - 929_000 })}`)).not.toBeNull();
    });

    it('alg none and HS256 tokens are refused', async () => {
      const a = oauthAuth();
      const hdr = (alg: string) => b64({ alg, typ: 'at+jwt', kid: keys.kid });
      const unsigned = `${hdr('none')}.${b64(claims())}.`;
      const hmac = (alg: string, key: string | Buffer) => {
        const body = `${hdr(alg)}.${b64(claims())}`;
        return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
      };
      const pub = keys.publicKey.export({ format: 'der', type: 'spki' });
      for (const t of [unsigned, hmac('HS256', JWT_KEY), hmac('HS256', pub)])
        expect(await a.authenticate(`Bearer ${t}`)).toBeNull();
    });

    it('an agent JWT and an API key still authenticate', async () => {
      const a = oauthAuth();
      const agent = signAgentJwt({
        key: JWT_KEY,
        userId: adminId,
        audience: AUD,
        now: Math.floor(t / 1000),
      });
      expect(await a.authenticate(`Bearer ${agent}`)).toMatchObject({ via: 'agent' });
      const { key } = await addKey(adminId);
      expect(await a.authenticate(`Bearer ${key}`)).toMatchObject({ via: 'api_key' });
    });

    it('an agent JWT is not an access token, and an access token is not an agent JWT', async () => {
      const a = oauthAuth();
      const body = token().split('.');
      const asAgent = `${b64({ alg: 'HS256', typ: 'agent+jwt' })}.${body[1]}.${body[2]}`;
      expect(await a.authenticate(`Bearer ${asAgent}`)).toBeNull();
    });

    it('revoke ends access on the next call: a token whose consent row is gone is refused', async () => {
      const a = oauthAuth();
      const tok = `Bearer ${token()}`;
      expect(await a.authenticate(tok)).toMatchObject({ via: 'oauth', userId: adminId });
      await revokeConsent(adminId, 'dcr_test');
      expect(await a.authenticate(tok)).toBeNull();
    });

    it('a consent row of another client or another user does not count', async () => {
      await revokeConsent(adminId, 'dcr_test');
      await approve(adminId, 'dcr_other', t - 3_600_000);
      await approve(disabledId, 'dcr_test', t - 3_600_000);
      const a = oauthAuth();
      expect(await a.authenticate(`Bearer ${token()}`)).toBeNull();
      expect(await a.authenticate(`Bearer ${token({ client: 'dcr_other' })}`)).not.toBeNull();
    });

    it('revoke then approve again within 15 minutes does not revive the old token', async () => {
      const a = oauthAuth();
      const old = `Bearer ${token({ at: t - 30_000 })}`;
      expect(await a.authenticate(old)).not.toBeNull();
      await revokeConsent(adminId, 'dcr_test');
      await approve(adminId, 'dcr_test', t);
      expect(await a.authenticate(old)).toBeNull();
      // A token issued after the new approval works, and so does one from the same second.
      expect(await a.authenticate(`Bearer ${token({ at: t + 5_000 })}`)).not.toBeNull();
      expect(await a.authenticate(`Bearer ${token({ at: t })}`)).not.toBeNull();
    });

    it('an agent JWT and an API key need no consent row', async () => {
      await revokeConsent(adminId, 'dcr_test');
      const a = oauthAuth();
      const agent = signAgentJwt({
        key: JWT_KEY,
        userId: adminId,
        audience: AUD,
        now: Math.floor(t / 1000),
      });
      expect(await a.authenticate(`Bearer ${agent}`)).toMatchObject({ via: 'agent' });
      const { key } = await addKey(adminId);
      expect(await a.authenticate(`Bearer ${key}`)).toMatchObject({ via: 'api_key' });
    });

    it('with oauth off an at+jwt is refused', async () => {
      expect(await auth().authenticate(`Bearer ${token()}`)).toBeNull();
    });
  });
});
