import { generateApiKey, signAgentJwt } from '@woo/core';
import { schema } from '@woo/core/db';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Authenticator } from './auth.js';
import { migratedDatabase, TEST_DATABASE_URL } from './test-db.js';
import { quietLog } from './test-helpers.js';
import type { Db } from './types.js';

const PEPPER = 'test-pepper';
const JWT_KEY = 'test-jwt-key';
const AUD = 'http://mcp.test/mcp';

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
    });
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
});
