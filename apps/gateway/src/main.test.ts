import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { encryptSecret, generateApiKey, oauthKeys, signAccessToken } from '@woo/core';
import { schema } from '@woo/core/db';
import { eq, inArray } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startGateway } from './main.js';
import { migratedDatabase, TEST_DATABASE_URL } from './test-db.js';
import { fakeUpstream } from './test-helpers.js';
import type { Db } from './types.js';

const PEPPER = 'main-pepper';
const kek = randomBytes(32);
const ISSUER = 'http://app.test';
const AUDIENCE = 'http://mcp.test/mcp';
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

describe.skipIf(!TEST_DATABASE_URL)('startGateway against Postgres', () => {
  let pool: pg.Pool;
  let db: Db;
  let gw: Awaited<ReturnType<typeof startGateway>>;
  let main: Awaited<ReturnType<typeof fakeUpstream>>;
  let fx: Awaited<ReturnType<typeof fakeUpstream>>;
  // Every Authorization header the main upstream received: only its stored credential may appear.
  const mainAuth: string[] = [];
  let key: string;
  let keyId: string;
  let userId: string;
  let fxId: string;
  let mcpUrl: URL;

  beforeAll(async () => {
    const created = await migratedDatabase('woo_gw_main_test');
    ({ pool, db } = created);
    main = await fakeUpstream({
      tools: new Map([['get_info', async () => text('get_info ok')]]),
      accept: (req) => {
        mainAuth.push(req.headers.authorization ?? '');
        return req.headers.authorization === 'Bearer main-token';
      },
    });
    fx = await fakeUpstream({
      tools: new Map([
        ['get_info', async () => text('get_info ok')],
        ['convert', async () => text('convert ok')],
      ]),
      accept: (req) => req.headers.authorization === 'Bearer fx-token',
    });
    const [u] = await db
      .insert(schema.users)
      .values({ email: 'admin@example.com', role: 'admin', status: 'active' })
      .returning({ id: schema.users.id });
    const k = generateApiKey(PEPPER);
    const [kr] = await db
      .insert(schema.apiKeys)
      .values({ userId: u!.id, name: 'e2e', prefix: k.prefix, secretHash: k.secretHash })
      .returning({ id: schema.apiKeys.id });
    key = k.key;
    keyId = kr!.id;
    userId = u!.id;
    const servers = await db
      .insert(schema.mcpServers)
      .values([
        {
          slug: 'main',
          name: 'Main Store',
          url: main.url,
          kind: 'store',
          authType: 'bearer',
          authSecretEnc: encryptSecret('main-token', kek, 'main'),
        },
        {
          slug: 'fx',
          name: 'FX',
          url: fx.url,
          kind: 'system',
          authType: 'bearer',
          authSecretEnc: encryptSecret('fx-token', kek, 'fx'),
        },
      ])
      .returning({ id: schema.mcpServers.id, slug: schema.mcpServers.slug });
    fxId = servers.find((s) => s.slug === 'fx')!.id;
    gw = await startGateway(
      {
        databaseUrl: created.url,
        kek,
        pepper: PEPPER,
        jwtKey: 'jwt',
        audience: AUDIENCE,
        replica: 'gw-e2e-0',
        allowedOrigins: [],
        port: 0,
        healthPort: 0,
        allowInsecureUpstreams: false,
        rateLimitPerMinute: 60,
        oauthEnabled: true,
        oauthIssuer: ISSUER,
      },
      {
        host: '127.0.0.1',
        logger: false,
        upstream: { healthIntervalMs: 200 },
        listenRecheckMs: 200,
      },
    );
    mcpUrl = new URL(`http://127.0.0.1:${gw.port}/mcp`);
  }, 30_000);

  afterAll(async () => {
    await gw?.close();
    await main?.close();
    await fx?.close();
    await pool?.end();
  });

  async function connect() {
    const c = new Client({ name: 'e2e', version: '0.0.0' });
    await c.connect(
      new StreamableHTTPClientTransport(mcpUrl, {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    return c;
  }

  it('is ready and lists the seeded servers', async () => {
    expect((await fetch(`http://127.0.0.1:${gw.healthPort}/readyz`)).status).toBe(200);
    const c = await connect();
    await vi.waitFor(
      async () =>
        expect(
          (await c.listTools(undefined, { cacheMode: 'bypass' })).tools.map((t) => t.name),
        ).toEqual(['fx__convert', 'fx__get_info', 'main__get_info']),
      { timeout: 5000 },
    );
    const { tools } = await c.listTools(undefined, { cacheMode: 'bypass' });
    expect(tools.find((t) => t.name === 'main__get_info')?.description).toBe(
      '[Store: Main Store] get_info tool',
    );
    await c.close();
  });

  it('routes a call with only the stored credential and writes the audit row', async () => {
    const c = await connect();
    expect((await c.callTool({ name: 'main__get_info', arguments: {} })).content).toEqual([
      { type: 'text', text: 'get_info ok' },
    ]);
    await c.close();
    expect(mainAuth.length).toBeGreaterThan(0);
    expect(mainAuth.every((h) => h === 'Bearer main-token')).toBe(true);
    expect(mainAuth.join(' ')).not.toContain('urk_');
    const [row] = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.exposedName, 'main__get_info'));
    expect(row).toMatchObject({
      outcome: 'ok',
      replica: 'gw-e2e-0',
      via: 'api_key',
      apiKeyId: keyId,
      serverSlug: 'main',
    });
    expect(row?.argsSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('serves resource metadata and accepts an OAuth access token, audited via oauth', async () => {
    const base = `http://127.0.0.1:${gw.port}`;
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(prm).toMatchObject({ resource: AUDIENCE, authorization_servers: [ISSUER] });
    const noToken = await fetch(`${base}/mcp`, { method: 'POST' });
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get('www-authenticate')).toContain(
      'resource_metadata="http://mcp.test/.well-known/oauth-protected-resource"',
    );

    // The user approved this client, which is what the gateway checks next to the signature.
    await db
      .insert(schema.oauthConsents)
      .values({ userId, clientId: 'dcr_main_test', scope: 'mcp:tools' });
    // The control-plane signs with the same JWT_SIGNING_KEY the gateway was started with ('jwt').
    const token = signAccessToken({
      keys: oauthKeys('jwt'),
      iss: ISSUER,
      aud: AUDIENCE,
      sub: userId,
      clientId: 'dcr_main_test',
      scope: 'mcp:tools',
    });
    const c = new Client({ name: 'e2e-oauth', version: '0.0.0' });
    await c.connect(
      new StreamableHTTPClientTransport(mcpUrl, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    await vi.waitFor(
      async () =>
        expect(
          (await c.listTools(undefined, { cacheMode: 'bypass' })).tools.length,
        ).toBeGreaterThan(0),
      { timeout: 5000 },
    );
    await c.callTool({ name: 'fx__get_info', arguments: {} });
    await c.close();
    const rows = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.via, 'oauth'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, apiKeyId: null, exposedName: 'fx__get_info' });

    const bad = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.e30.' },
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  describe('listen streams end with the credential they were opened with', () => {
    async function listenWith(headers: Record<string, string>) {
      const c = new Client(
        { name: 'e2e-listen', version: '0.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      await c.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers } }));
      const sub = await c.listen({ toolsListChanged: true });
      const ended = Promise.race([
        sub.closed,
        new Promise<string>((r) => setTimeout(() => r('still open'), 4000)),
      ]);
      return { c, ended };
    }

    it('an OAuth stream closes within the recheck interval after its grant is revoked', async () => {
      await db
        .insert(schema.oauthConsents)
        .values({ userId, clientId: 'dcr_listen', scope: 'mcp:tools' });
      const token = signAccessToken({
        keys: oauthKeys('jwt'),
        iss: ISSUER,
        aud: AUDIENCE,
        sub: userId,
        clientId: 'dcr_listen',
        scope: 'mcp:tools',
      });
      const { c, ended } = await listenWith({ Authorization: `Bearer ${token}` });
      await db.delete(schema.oauthConsents).where(eq(schema.oauthConsents.clientId, 'dcr_listen'));
      expect(await ended).toMatch(/^(remote|graceful)$/);
      await c.close().catch(() => {});
    });

    it('an API key stream closes after the key is revoked', async () => {
      const k = generateApiKey(PEPPER);
      const [row] = await db
        .insert(schema.apiKeys)
        .values({ userId, name: 'listen', prefix: k.prefix, secretHash: k.secretHash })
        .returning({ id: schema.apiKeys.id });
      const { c, ended } = await listenWith({ Authorization: `Bearer ${k.key}` });
      await db
        .update(schema.apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(schema.apiKeys.id, row!.id));
      // What the control-plane sends in the same transaction: it drops the gateway's 10 s key cache.
      await pool.query('select pg_notify($1, $2)', ['key_revoked', row!.id]);
      expect(await ended).toMatch(/^(remote|graceful)$/);
      await c.close().catch(() => {});
    });

    it('a stream whose credential is still good stays open and hears tools_changed', async () => {
      const c = new Client(
        { name: 'e2e-listen', version: '0.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      let heard = 0;
      c.setNotificationHandler('notifications/tools/list_changed', () => {
        heard++;
      });
      await c.connect(
        new StreamableHTTPClientTransport(mcpUrl, {
          requestInit: { headers: { Authorization: `Bearer ${key}` } },
        }),
      );
      await c.listen({ toolsListChanged: true });
      await new Promise((r) => setTimeout(r, 600));
      await pool.query("select pg_notify('tools_changed', '')");
      await vi.waitFor(() => expect(heard).toBe(1), { timeout: 3000 });
      await c.close().catch(() => {});
    });
  });

  it('stores meta_tool on search and call_tool audit rows', async () => {
    const c = new Client({ name: 'e2e', version: '0.0.0' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${mcpUrl.href}?toolMode=search`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['call_tool', 'search_tools']);
    await c.callTool({ name: 'search_tools', arguments: { query: 'get info' } });
    await c.callTool({ name: 'call_tool', arguments: { name: 'main__get_info' } });
    await c.close();
    const rows = await db
      .select({
        tool: schema.auditEvents.toolName,
        meta: schema.auditEvents.metaTool,
        slug: schema.auditEvents.serverSlug,
      })
      .from(schema.auditEvents)
      .where(inArray(schema.auditEvents.metaTool, ['search_tools', 'call_tool']));
    expect(rows.sort((a, b) => a.meta!.localeCompare(b.meta!))).toEqual([
      { tool: 'get_info', meta: 'call_tool', slug: 'main' },
      { tool: 'search_tools', meta: 'search_tools', slug: '' },
    ]);
  });

  it('persists tools and writes status rows', async () => {
    await vi.waitFor(
      async () => {
        const tools = await db.select({ n: schema.mcpTools.exposedName }).from(schema.mcpTools);
        expect(tools.map((t) => t.n).sort()).toEqual([
          'fx__convert',
          'fx__get_info',
          'main__get_info',
        ]);
        const status = await db.select().from(schema.mcpServerStatus);
        expect(status.map((s) => [s.state, s.toolCount]).sort()).toEqual([
          ['connected', 1],
          ['connected', 2],
        ]);
      },
      { timeout: 5000 },
    );
  });

  it('hides a server disabled through NOTIFY and says so on call', async () => {
    await db
      .update(schema.mcpServers)
      .set({ enabled: false })
      .where(eq(schema.mcpServers.id, fxId));
    await pool.query("select pg_notify('registry_changed', $1)", [fxId]);
    const c = await connect();
    await vi.waitFor(async () =>
      expect(
        (await c.listTools(undefined, { cacheMode: 'bypass' })).tools.map((t) => t.name),
      ).toEqual(['main__get_info']),
    );
    expect(await c.callTool({ name: 'fx__get_info', arguments: {} })).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Server fx is disabled' }],
    });
    await c.close();
  });

  it('rejects every cached key of a user disabled in the database within a second of key_revoked', async () => {
    const [u] = await db
      .insert(schema.users)
      .values({ email: 'leaver@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    const keys = [generateApiKey(PEPPER), generateApiKey(PEPPER)];
    const rows = await db
      .insert(schema.apiKeys)
      .values(
        keys.map((k, i) => ({
          userId: u!.id,
          name: `leaver-${i}`,
          prefix: k.prefix,
          secretHash: k.secretHash,
        })),
      )
      .returning({ id: schema.apiKeys.id });
    const status = async (k: string) =>
      (
        await fetch(mcpUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${k}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        })
      ).status;
    // One request each puts both keys in the gateway's cache.
    for (const k of keys) expect(await status(k.key)).not.toBe(401);
    // What PATCH /api/users/:id commits: the user disabled, keys left unrevoked, one NOTIFY per key.
    await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, u!.id));
    for (const r of rows) await pool.query("select pg_notify('key_revoked', $1)", [r.id]);
    await vi.waitFor(
      async () => {
        for (const k of keys) expect(await status(k.key)).toBe(401);
      },
      { timeout: 1000, interval: 50 },
    );
  });

  it('rejects a key within a second of NOTIFY key_revoked', async () => {
    await db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.id, keyId));
    await pool.query("select pg_notify('key_revoked', $1)", [keyId]);
    await vi.waitFor(
      async () => {
        const res = await fetch(mcpUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        });
        expect(res.status).toBe(401);
      },
      { timeout: 1000, interval: 50 },
    );
  });
});
