import { hashApiKeySecret, parseApiKey } from '@woo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notify, withTx } from './db.js';
import { call, listen, TEST_PEPPER, testApi, userWithSession } from './test-app.js';

type U = { id: string; cookie: string };
const ids = (body: { keys: Array<{ id: string }> }) => body.keys.map((k) => k.id);

describe.skipIf(!process.env.TEST_DATABASE_URL)('keys API (needs TEST_DATABASE_URL)', () => {
  let t: Awaited<ReturnType<typeof testApi>>;
  let admin: U;
  let alice: U;
  let bob: U;
  beforeAll(async () => {
    t = await testApi('woo_api_keys_test');
    admin = await userWithSession(t.pool, 'admin@example.com', 'admin');
    alice = await userWithSession(t.pool, 'alice@example.com');
    bob = await userWithSession(t.pool, 'bob@example.com');
  });
  afterAll(async () => {
    await t.close();
  });

  const create = (cookie: string, name = 'laptop') =>
    call(t.app, 'POST', '/api/keys', { cookie, body: { name } });
  const revoke = (id: string, cookie: string) =>
    call(t.app, 'DELETE', `/api/keys/${id}`, { cookie });

  it('creates a key shown once and stores only an HMAC of its secret', async () => {
    const r = await create(alice.cookie);
    expect(r.statusCode).toBe(201);
    const { key, secret } = r.json();
    const parsed = parseApiKey(secret)!;
    expect(parsed.prefix).toBe(key.prefix);
    const row = await t.pool.query('select user_id, secret_hash from api_keys where id = $1', [
      key.id,
    ]);
    expect(row.rows[0]).toEqual({
      user_id: alice.id,
      secret_hash: hashApiKeySecret(parsed.secret, TEST_PEPPER),
    });
    const list = await call(t.app, 'GET', '/api/keys', { cookie: alice.cookie });
    expect(ids(list.json())).toContain(key.id);
    expect(list.body).not.toContain(parsed.secret);
    expect(list.body).not.toContain('secret');
  });

  it('lists only your own keys', async () => {
    const { key } = (await create(bob.cookie, 'bob-key')).json();
    expect(
      ids((await call(t.app, 'GET', '/api/keys', { cookie: alice.cookie })).json()),
    ).not.toContain(key.id);
  });

  it('revokes your own key and sends key_revoked on commit', async () => {
    const { key } = (await create(alice.cookie)).json();
    const l = await listen(t.url, 'key_revoked');
    try {
      expect((await revoke(key.id, alice.cookie)).statusCode).toBe(204);
      expect(await l.waitFor(1)).toEqual([key.id]);
    } finally {
      await l.close();
    }
    const row = await t.pool.query('select revoked_at from api_keys where id = $1', [key.id]);
    expect(row.rows[0].revoked_at).not.toBeNull();
  });

  it("gives a member 404 for someone else's key and changes nothing", async () => {
    const { key } = (await create(bob.cookie)).json();
    const l = await listen(t.url, 'key_revoked');
    try {
      expect((await revoke(key.id, alice.cookie)).statusCode).toBe(404);
      expect(await l.waitFor(1, 300)).toEqual([]);
    } finally {
      await l.close();
    }
    const row = await t.pool.query('select revoked_at from api_keys where id = $1', [key.id]);
    expect(row.rows[0].revoked_at).toBeNull();
  });

  it('lets an admin revoke any key; a repeat keeps the first revoked_at', async () => {
    const { key } = (await create(bob.cookie)).json();
    expect((await revoke(key.id, admin.cookie)).statusCode).toBe(204);
    const first = (await t.pool.query('select revoked_at from api_keys where id = $1', [key.id]))
      .rows[0].revoked_at as Date;
    expect((await revoke(key.id, admin.cookie)).statusCode).toBe(204);
    const again = (await t.pool.query('select revoked_at from api_keys where id = $1', [key.id]))
      .rows[0].revoked_at as Date;
    expect(again.getTime()).toBe(first.getTime());
  });

  it('answers malformed and unknown ids with 404', async () => {
    for (const id of ['abc', '1', '00000000-0000-4000-8000-000000000000']) {
      expect((await revoke(id, admin.cookie)).statusCode).toBe(404);
    }
  });

  it('does not deliver key_revoked from a transaction that rolls back', async () => {
    const l = await listen(t.url, 'key_revoked');
    try {
      await expect(
        withTx(t.pool, async (c) => {
          await notify(c, 'key_revoked', alice.id);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await l.waitFor(1, 300)).toEqual([]);
    } finally {
      await l.close();
    }
  });

  it('lets an admin list and issue keys for a member; the key belongs to the member', async () => {
    const r = await call(t.app, 'POST', `/api/users/${bob.id}/keys`, {
      cookie: admin.cookie,
      body: { name: 'issued' },
    });
    expect(r.statusCode).toBe(201);
    const { key, secret } = r.json();
    const parsed = parseApiKey(secret)!;
    const owner = await t.pool.query('select user_id from api_keys where id = $1', [key.id]);
    expect(owner.rows[0].user_id).toBe(bob.id);
    expect(ids((await call(t.app, 'GET', '/api/keys', { cookie: bob.cookie })).json())).toContain(
      key.id,
    );
    expect(
      ids((await call(t.app, 'GET', '/api/keys', { cookie: admin.cookie })).json()),
    ).not.toContain(key.id);
    const viaAdmin = await call(t.app, 'GET', `/api/users/${bob.id}/keys`, {
      cookie: admin.cookie,
    });
    expect(ids(viaAdmin.json())).toContain(key.id);
    expect(viaAdmin.body).not.toContain(parsed.secret);
  });

  it('keeps admin key routes from members and refuses keys for users who cannot sign in', async () => {
    expect(
      (await call(t.app, 'GET', `/api/users/${bob.id}/keys`, { cookie: alice.cookie })).statusCode,
    ).toBe(403);
    const asMember = await call(t.app, 'POST', `/api/users/${bob.id}/keys`, {
      cookie: alice.cookie,
      body: { name: 'x' },
    });
    expect(asMember.statusCode).toBe(403);
    const d = await userWithSession(t.pool, 'disabled@example.com');
    await t.pool.query(`update users set status = 'disabled' where id = $1`, [d.id]);
    const issue = await call(t.app, 'POST', `/api/users/${d.id}/keys`, {
      cookie: admin.cookie,
      body: { name: 'x' },
    });
    expect(issue.json()).toEqual({ error: 'user_not_active' });
    const unknown = await call(
      t.app,
      'GET',
      '/api/users/00000000-0000-4000-8000-000000000000/keys',
      {
        cookie: admin.cookie,
      },
    );
    expect(unknown.statusCode).toBe(404);
  });

  it('validates names and keeps the Origin check on every key write', async () => {
    expect((await create(alice.cookie, '   ')).statusCode).toBe(400);
    const noOrigin = await call(t.app, 'POST', '/api/keys', {
      cookie: alice.cookie,
      origin: null,
      body: { name: 'x' },
    });
    expect(noOrigin.statusCode).toBe(403);
    const evil = await call(t.app, 'DELETE', `/api/keys/${alice.id}`, {
      cookie: alice.cookie,
      origin: 'http://evil.example',
    });
    expect(evil.statusCode).toBe(403);
    const issueNoOrigin = await call(t.app, 'POST', `/api/users/${bob.id}/keys`, {
      cookie: admin.cookie,
      origin: null,
      body: { name: 'x' },
    });
    expect(issueNoOrigin.statusCode).toBe(403);
  });
});
