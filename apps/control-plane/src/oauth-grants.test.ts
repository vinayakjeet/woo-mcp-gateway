import { randomBytes } from 'node:crypto';
import { hashToken } from '@woo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, ORIGIN, testApi, userWithSession } from './test-app.js';

const base = process.env.TEST_DATABASE_URL;
const RESOURCE = 'http://mcp.127.0.0.1.nip.io/mcp';
const REDIRECT = 'http://127.0.0.1:53682/callback';
const CIMD_ID = 'https://claude.ai/oauth/claude-code-client-metadata';

type U = { id: string; cookie: string };

describe.skipIf(!base)('connected apps API (needs TEST_DATABASE_URL)', () => {
  let t: Awaited<ReturnType<typeof testApi>>;
  let off: Awaited<ReturnType<typeof testApi>>;
  let admin: U;
  let asha: U;
  let bob: U;
  let ipN = 0;

  const grants = (cookie: string, qs = '') =>
    call(t.app, 'GET', `/api/oauth/grants${qs}`, { cookie });
  const revoke = (clientId: string, cookie: string, qs = '') =>
    call(t.app, 'DELETE', `/api/oauth/grants/${encodeURIComponent(clientId)}${qs}`, { cookie });

  async function addClient(name: string, o: { cimd?: boolean } = {}): Promise<string> {
    const id = o.cimd ? CIMD_ID : `dcr_${randomBytes(16).toString('base64url')}`;
    await t.pool.query(
      `insert into oauth_clients (client_id, name, redirect_uris, metadata_url)
       values ($1, $2, $3::jsonb, $4)
       on conflict (client_id) do update set name = excluded.name`,
      [id, name, JSON.stringify([REDIRECT]), o.cimd ? id : null],
    );
    return id;
  }
  const consent = (userId: string, clientId: string) =>
    t.pool.query(
      `insert into oauth_consents (user_id, client_id, scope) values ($1, $2, 'mcp:tools')
       on conflict (user_id, client_id) do update set created_at = now()`,
      [userId, clientId],
    );
  async function refreshToken(userId: string, clientId: string, parent?: string) {
    const plain = `urt_${randomBytes(32).toString('base64url')}`;
    const r = await t.pool.query<{ id: string }>(
      `insert into oauth_refresh_tokens (token_hash, client_id, user_id, resource, scope, expires_at)
       values ($1, $2, $3, $4, 'mcp:tools', now() + interval '30 days') returning id`,
      [hashToken(plain), clientId, userId, RESOURCE],
    );
    const id = r.rows[0]!.id;
    if (parent)
      await t.pool.query(
        'update oauth_refresh_tokens set replaced_by = $2, revoked_at = now() where id = $1',
        [parent, id],
      );
    return { plain, id };
  }
  const liveTokens = async (userId: string, clientId: string) =>
    Number(
      (
        await t.pool.query(
          `select count(*)::int as n from oauth_refresh_tokens
           where user_id = $1 and client_id = $2 and revoked_at is null`,
          [userId, clientId],
        )
      ).rows[0].n,
    );
  const consentRows = async (userId: string, clientId: string) =>
    Number(
      (
        await t.pool.query(
          'select count(*)::int as n from oauth_consents where user_id = $1 and client_id = $2',
          [userId, clientId],
        )
      ).rows[0].n,
    );
  const refresh = (plain: string, clientId: string) => {
    const p = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: plain,
    });
    return t.app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': `192.0.2.${(ipN = (ipN % 250) + 1)}`,
      },
      payload: p.toString(),
    });
  };

  beforeAll(async () => {
    t = await testApi('woo_oauth_grants_test', {}, false, {});
    off = await testApi('woo_oauth_grants_off_test');
    admin = await userWithSession(t.pool, 'admin@example.com', 'admin');
    asha = await userWithSession(t.pool, 'asha@example.com');
    bob = await userWithSession(t.pool, 'bob@example.com');
  });
  afterAll(async () => {
    await t.close();
    await off.close();
  });

  it('lists name, kind, host for a CIMD client, approved time and last refreshed time', async () => {
    const dcr = await addClient('MCP Inspector');
    const cimd = await addClient('Claude Code', { cimd: true });
    await consent(asha.id, dcr);
    await consent(asha.id, cimd);
    const first = await refreshToken(asha.id, dcr);
    await refreshToken(asha.id, dcr, first.id);
    await refreshToken(asha.id, cimd);

    const res = await grants(asha.cookie);
    expect(res.statusCode).toBe(200);
    const byId = new Map(
      (res.json().grants as Array<Record<string, unknown>>).map((g) => [g.clientId, g]),
    );
    expect(byId.get(dcr)).toMatchObject({ name: 'MCP Inspector', kind: 'dcr', host: null });
    expect(byId.get(cimd)).toMatchObject({
      name: 'Claude Code',
      kind: 'cimd',
      host: 'claude.ai',
    });
    expect(Date.parse(byId.get(dcr)!.approvedAt as string)).not.toBeNaN();
    // The first token is the grant itself, a refresh is a token with a parent.
    expect(Date.parse(byId.get(dcr)!.lastRefreshedAt as string)).not.toBeNaN();
    expect(byId.get(cimd)!.lastRefreshedAt).toBeNull();
    expect(res.body).not.toContain('urt_');
    expect(res.body).not.toContain('token_hash');
  });

  it('a member sees only their own grants, may name themselves, and gets 403 for another user', async () => {
    const c = await addClient('Bob app');
    await consent(bob.id, c);
    const own = await grants(bob.cookie);
    expect(own.json().grants.map((g: { clientId: string }) => g.clientId)).toEqual([c]);
    const named = await grants(bob.cookie, `?userId=${bob.id}`);
    expect(named.statusCode).toBe(200);
    const other = await grants(bob.cookie, `?userId=${asha.id}`);
    expect(other.statusCode).toBe(403);
    expect(other.json()).toEqual({ error: 'forbidden' });
    const del = await revoke(c, asha.cookie, `?userId=${bob.id}`);
    expect(del.statusCode).toBe(403);
    expect(await consentRows(bob.id, c)).toBe(1);
    // The member's own list never carries someone else's rows.
    expect(
      (await grants(asha.cookie)).json().grants.map((g: { clientId: string }) => g.clientId),
    ).not.toContain(c);
  });

  it('refuses a userId that is not a uuid and an unknown user', async () => {
    expect((await grants(admin.cookie, '?userId=nope')).statusCode).toBe(400);
    const unknown = await grants(admin.cookie, '?userId=00000000-0000-4000-8000-0000000000ff');
    expect(unknown.statusCode).toBe(404);
  });

  it("an admin lists and revokes another user's grant, and their own list stays their own", async () => {
    const c = await addClient('Asha tool');
    await consent(asha.id, c);
    await refreshToken(asha.id, c);
    expect(
      (await grants(admin.cookie)).json().grants.map((g: { clientId: string }) => g.clientId),
    ).not.toContain(c);
    const theirs = await grants(admin.cookie, `?userId=${asha.id}`);
    expect(theirs.json().grants.map((g: { clientId: string }) => g.clientId)).toContain(c);
    const del = await revoke(c, admin.cookie, `?userId=${asha.id}`);
    expect(del.statusCode).toBe(204);
    expect(await consentRows(asha.id, c)).toBe(0);
    expect(await liveTokens(asha.id, c)).toBe(0);
  });

  it('revoke ends every live refresh token of the pair and leaves other clients and users alone', async () => {
    const target = await addClient('Target');
    const other = await addClient('Other');
    for (const u of [asha, bob]) {
      await consent(u.id, target);
      await consent(u.id, other);
    }
    const a = await refreshToken(asha.id, target);
    await refreshToken(asha.id, target, a.id);
    await refreshToken(asha.id, target);
    await refreshToken(asha.id, other);
    await refreshToken(bob.id, target);
    // A code not yet redeemed must not turn into a new grant after the revoke.
    await t.pool.query(
      `insert into oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, expires_at)
       values ($1, $2, $3, $4, 'c', $5, 'mcp:tools', now() + interval '60 seconds')`,
      [hashToken('code-x'), target, asha.id, REDIRECT, RESOURCE],
    );
    expect(await liveTokens(asha.id, target)).toBe(2);

    const res = await revoke(target, asha.cookie);
    expect(res.statusCode).toBe(204);
    expect(await liveTokens(asha.id, target)).toBe(0);
    expect(await consentRows(asha.id, target)).toBe(0);
    expect(await liveTokens(asha.id, other)).toBe(1);
    expect(await consentRows(asha.id, other)).toBe(1);
    expect(await liveTokens(bob.id, target)).toBe(1);
    expect(await consentRows(bob.id, target)).toBe(1);
    const code = await t.pool.query('select used_at from oauth_codes where code_hash = $1', [
      hashToken('code-x'),
    ]);
    expect(code.rows[0].used_at).not.toBeNull();
  });

  it('after revoke the refresh token is invalid_grant, and a token of another client still works', async () => {
    const target = await addClient('Refresh target');
    const keep = await addClient('Refresh keep');
    await consent(asha.id, target);
    await consent(asha.id, keep);
    const live = await refreshToken(asha.id, target);
    const kept = await refreshToken(asha.id, keep);
    expect((await revoke(target, asha.cookie)).statusCode).toBe(204);
    const dead = await refresh(live.plain, target);
    expect(dead.statusCode).toBe(400);
    expect(dead.json().error).toBe('invalid_grant');
    expect((await refresh(kept.plain, keep)).statusCode).toBe(200);
  });

  it('revoke needs the session cookie and the Origin header', async () => {
    const c = await addClient('Needs origin');
    await consent(asha.id, c);
    await refreshToken(asha.id, c);
    const noCookie = await call(t.app, 'DELETE', `/api/oauth/grants/${encodeURIComponent(c)}`);
    expect(noCookie.statusCode).toBe(401);
    const noOrigin = await call(t.app, 'DELETE', `/api/oauth/grants/${encodeURIComponent(c)}`, {
      cookie: asha.cookie,
      origin: null,
    });
    expect(noOrigin.statusCode).toBe(403);
    const wrongOrigin = await call(t.app, 'DELETE', `/api/oauth/grants/${encodeURIComponent(c)}`, {
      cookie: asha.cookie,
      origin: 'https://evil.example',
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect((await call(t.app, 'GET', '/api/oauth/grants')).statusCode).toBe(401);
    expect(await consentRows(asha.id, c)).toBe(1);
    expect(await liveTokens(asha.id, c)).toBe(1);
    expect(ORIGIN).toBeTruthy();
  });

  it('revokes a CIMD client whose id is an https URL, percent-encoded in the path', async () => {
    const c = await addClient('Claude Code', { cimd: true });
    await consent(bob.id, c);
    await refreshToken(bob.id, c);
    expect(encodeURIComponent(c)).toContain('%2F');
    const res = await revoke(c, bob.cookie);
    expect(res.statusCode).toBe(204);
    expect(await consentRows(bob.id, c)).toBe(0);
    expect(await liveTokens(bob.id, c)).toBe(0);
  });

  it('an unknown or already revoked grant is 404', async () => {
    expect((await revoke('dcr_nope', asha.cookie)).statusCode).toBe(404);
    const c = await addClient('Twice');
    await consent(asha.id, c);
    expect((await revoke(c, asha.cookie)).statusCode).toBe(204);
    expect((await revoke(c, asha.cookie)).statusCode).toBe(404);
  });

  it('a revoked grant that is approved again appears again', async () => {
    const c = await addClient('Comes back');
    await consent(asha.id, c);
    await revoke(c, asha.cookie);
    const gone = await grants(asha.cookie);
    expect(gone.json().grants.map((g: { clientId: string }) => g.clientId)).not.toContain(c);
    await consent(asha.id, c);
    const back = await grants(asha.cookie);
    expect(back.json().grants.map((g: { clientId: string }) => g.clientId)).toContain(c);
  });

  it('writes one oauth_grant_revoked audit row for the owner with the actor and the client, and no token', async () => {
    const c = await addClient('Audited');
    await consent(asha.id, c);
    const tok = await refreshToken(asha.id, c);
    const before = Number(
      (
        await t.pool.query(
          `select count(*)::int as n from audit_events where tool_name = 'oauth_grant_revoked'`,
        )
      ).rows[0].n,
    );
    expect((await revoke(c, admin.cookie, `?userId=${asha.id}`)).statusCode).toBe(204);
    const rows = (
      await t.pool.query(
        `select * from audit_events where tool_name = 'oauth_grant_revoked' and exposed_name = $1`,
        [c],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: asha.id,
      user_email: 'asha@example.com',
      via: 'oauth',
      server_slug: '',
      outcome: 'ok',
      api_key_id: null,
    });
    expect(rows[0].error_message).toBe('revoked by admin@example.com');
    const all = JSON.stringify(rows[0]);
    expect(all).not.toContain(tok.plain);
    expect(all).not.toContain(hashToken(tok.plain));
    const after = Number(
      (
        await t.pool.query(
          `select count(*)::int as n from audit_events where tool_name = 'oauth_grant_revoked'`,
        )
      ).rows[0].n,
    );
    expect(after).toBe(before + 1);
    // The owner sees it in their own audit log, and Health ignores it (no server slug).
    const log = await call(t.app, 'GET', '/api/audit', { cookie: asha.cookie });
    expect(log.json().items.map((i: { toolName: string }) => i.toolName)).toContain(
      'oauth_grant_revoked',
    );
    const health = await call(t.app, 'GET', '/api/stats/servers', { cookie: admin.cookie });
    expect(health.body).not.toContain('oauth_grant_revoked');
  });

  it('a 404 revoke writes no audit row', async () => {
    const n = async () =>
      Number(
        (
          await t.pool.query(
            `select count(*)::int as n from audit_events where tool_name = 'oauth_grant_revoked'`,
          )
        ).rows[0].n,
      );
    const before = await n();
    await revoke('dcr_missing', asha.cookie);
    expect(await n()).toBe(before);
  });

  it('with OAuth off the routes do not exist', async () => {
    const u = await userWithSession(off.pool, 'someone@example.com');
    const res = await call(off.app, 'GET', '/api/oauth/grants', { cookie: u.cookie });
    expect(res.statusCode).toBe(404);
  });
});
