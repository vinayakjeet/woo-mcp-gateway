import { decryptSecret } from '@woo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HostedConfig } from './hosted-input.js';
import { migrateAndSeed } from './migrate-run.js';
import { ADMIN_PASSWORD, call, listen, testApi, userWithSession } from './test-app.js';
import { testStoreDefaults } from './test-stores.js';

type Who = { id: string; cookie: string };

const hosted: HostedConfig = {
  allowedImagePrefixes: ['fx-mcp:'],
  maxCpuMillis: 500,
  maxMemoryBytes: 256 * 1024 ** 2,
  gatewayNamespace: 'platform',
  gatewayLabels: { 'app.kubernetes.io/name': 'gateway' },
};
const provisioner = { storeDefaults: testStoreDefaults(), maxStoresPerUser: 3 };
const SECRET = 'S3CR3T-demo-value-91ab';

const body = (over: Record<string, unknown> = {}) => ({
  slug: 'fx2',
  image: 'fx-mcp:dev',
  port: 8080,
  cpu: '200m',
  memory: '128Mi',
  env: [{ name: 'LOG_LEVEL', value: 'info' }],
  secretEnv: [{ name: 'DEMO_SECRET', value: SECRET }],
  ...over,
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('hosted API (needs TEST_DATABASE_URL)', () => {
  let t: Awaited<ReturnType<typeof testApi>>;
  let admin: Who;
  let member: Who;
  const logs: string[] = [];

  beforeAll(async () => {
    t = await testApi(
      'woo_api_hosted_test',
      { provisioner, hosted },
      {
        level: 'trace',
        stream: { write: (s: string) => void logs.push(s) },
      },
    );
    admin = await userWithSession(t.pool, 'admin@example.com', 'admin');
    member = await userWithSession(t.pool, 'member@example.com');
  }, 30_000);
  afterAll(async () => {
    await t.close();
  });

  const post = (b: unknown, who: Who = admin) =>
    call(t.app, 'POST', '/api/hosted', { cookie: who.cookie, body: b });
  const row = async (slug: string) =>
    (
      await t.pool.query(
        `select h.*, s.id as sid, s.kind, s.managed, s.enabled, s.approval, s.protocol_mode,
           s.timeout_ms, s.url, s.name, s.auth_type, s.auth_secret_enc
         from hosted_servers h left join mcp_servers s on s.id = h.server_id where h.slug = $1`,
        [slug],
      )
    ).rows[0];

  it('answers 401 without a session and 403 to a member on all three routes', async () => {
    expect((await call(t.app, 'GET', '/api/hosted')).statusCode).toBe(401);
    for (const [m, url] of [
      ['GET', '/api/hosted'],
      ['POST', '/api/hosted'],
      ['DELETE', '/api/hosted/6b0c1e3a-5b4f-4f43-9c60-0d1f1a3c9a11'],
    ] as const) {
      const r = await call(t.app, m, url, {
        cookie: member.cookie,
        body: m === 'POST' ? body() : undefined,
      });
      expect(r.statusCode, `${m} ${url}`).toBe(403);
    }
    expect((await t.pool.query('select 1 from hosted_servers')).rowCount).toBe(0);
  });

  describe('create', () => {
    let notified: string[];
    let created: Awaited<ReturnType<typeof post>>;

    beforeAll(async () => {
      const l = await listen(t.url, 'hosted_changed');
      created = await post(body());
      notified = await l.waitFor(1);
      await l.close();
    });

    it('inserts a pending hosted row and answers 201 with the row', () => {
      expect(created.statusCode).toBe(201);
      const s = created.json().server;
      expect(s).toMatchObject({
        slug: 'fx2',
        image: 'fx-mcp:dev',
        port: 8080,
        path: '/mcp',
        cpu: '200m',
        memory: '128Mi',
        status: 'pending',
        env: [{ name: 'LOG_LEVEL', value: 'info' }],
        secretEnvNames: ['DEMO_SECRET'],
        url: 'http://fx2.mcp-hosted.svc.cluster.local:8080/mcp',
      });
      expect(notified).toHaveLength(1);
    });

    it('registers a disabled, managed, approved hosted server row named after the slug', async () => {
      const r = await row('fx2');
      expect(r).toMatchObject({
        status: 'pending',
        kind: 'hosted',
        managed: true,
        enabled: false,
        approval: 'approved',
        protocol_mode: 'legacy',
        timeout_ms: 15000,
        name: 'fx2',
        auth_type: 'bearer',
        url: 'http://fx2.mcp-hosted.svc.cluster.local:8080/mcp',
      });
      expect(created.json().server.serverId).toBe(r.sid);
    });

    it('stores the gateway token encrypted with the slug as AAD, as stores do', async () => {
      const r = await row('fx2');
      const token = decryptSecret(r.auth_secret_enc, t.kek, 'fx2');
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(() => decryptSecret(r.auth_secret_enc, t.kek, 'fx3')).toThrow();
      expect(r.auth_secret_enc.includes(Buffer.from(token))).toBe(false);
    });

    it('encrypts secret env with AAD hosted:<slug>; it holds the submitted values and the same token', async () => {
      const r = await row('fx2');
      const blob = JSON.parse(decryptSecret(r.secret_env_enc, t.kek, 'hosted:fx2')) as Record<
        string,
        string
      >;
      expect(blob.DEMO_SECRET).toBe(SECRET);
      expect(blob.MCP_SHARED_TOKEN).toBe(decryptSecret(r.auth_secret_enc, t.kek, 'fx2'));
      expect(Object.keys(blob).sort()).toEqual(['DEMO_SECRET', 'MCP_SHARED_TOKEN']);
      // A ciphertext cannot move between this column and the server row's secret.
      expect(() => decryptSecret(r.secret_env_enc, t.kek, 'fx2')).toThrow();
      expect(() => decryptSecret(r.auth_secret_enc, t.kek, 'hosted:fx2')).toThrow();
      expect(r.secret_env_enc.includes(Buffer.from(SECRET))).toBe(false);
    });

    it('never returns a secret value or the token, on create, list or the servers list', async () => {
      const token = decryptSecret((await row('fx2')).auth_secret_enc, t.kek, 'fx2');
      const list = await call(t.app, 'GET', '/api/hosted', { cookie: admin.cookie });
      const servers = await call(t.app, 'GET', '/api/servers', { cookie: admin.cookie });
      for (const text of [created.body, list.body, servers.body]) {
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(token);
        expect(text).not.toContain(Buffer.from(SECRET).toString('base64'));
      }
      expect(list.body).not.toContain('secret_env_enc');
      expect(list.body).not.toContain('secretEnvEnc');
    });

    it('lists the rows with secret env names only and the limits envelope', async () => {
      const r = await call(t.app, 'GET', '/api/hosted', { cookie: admin.cookie });
      expect(r.statusCode).toBe(200);
      expect(r.json().limits).toEqual({
        allowedImagePrefixes: ['fx-mcp:'],
        maxCpu: '500m',
        maxMemory: '256Mi',
      });
      const s = r.json().servers.find((x: { slug: string }) => x.slug === 'fx2');
      expect(s.secretEnvNames).toEqual(['DEMO_SECRET']);
      expect(s).not.toHaveProperty('secretEnv');
      expect(s).toHaveProperty('createdAt');
      expect(s).toHaveProperty('reason');
    });

    it('keeps the row disabled when an admin tries to enable it before it is ready', async () => {
      const r = await row('fx2');
      const p = await call(t.app, 'PATCH', `/api/servers/${r.sid}`, {
        cookie: admin.cookie,
        body: { enabled: true },
      });
      expect(p.statusCode).toBe(409);
      expect(p.json()).toEqual({ error: 'hosted_not_ready' });
      expect((await row('fx2')).enabled).toBe(false);
    });

    it('lets an admin enable it once the Deployment is ready', async () => {
      await t.pool.query(`update hosted_servers set status = 'ready' where slug = 'fx2'`);
      const r = await row('fx2');
      const p = await call(t.app, 'PATCH', `/api/servers/${r.sid}`, {
        cookie: admin.cookie,
        body: { enabled: true },
      });
      expect(p.statusCode).toBe(200);
      expect((await row('fx2')).enabled).toBe(true);
      await t.pool.query(`update hosted_servers set status = 'pending' where slug = 'fx2'`);
      await t.pool.query('update mcp_servers set enabled = false where id = $1', [r.sid]);
    });

    it('survives a seed run: the hosted server row is not rewritten', async () => {
      const before = await row('fx2');
      await migrateAndSeed({
        databaseUrl: t.url,
        kek: t.kek,
        adminEmail: 'admin@example.com',
        adminPassword: ADMIN_PASSWORD,
        seedServers: [
          {
            slug: 'fx',
            name: 'fx',
            url: 'http://fx-mcp.platform.svc.cluster.local:8080/mcp',
            kind: 'system',
            managed: true,
            protocolMode: 'auto',
            auth: { type: 'bearer', secret: 'x' },
          },
        ],
      });
      const after = await row('fx2');
      expect(after).toMatchObject({
        enabled: false,
        kind: 'hosted',
        url: before.url,
        status: 'pending',
        protocol_mode: 'legacy',
      });
      expect(after.auth_secret_enc.equals(before.auth_secret_enc)).toBe(true);
      expect(after.sid).toBe(before.sid);
    });
  });

  describe('create refusals', () => {
    const count = async () =>
      Number(
        (
          await t.pool.query(
            `select (select count(*) from hosted_servers) + (select count(*) from mcp_servers) as n`,
          )
        ).rows[0].n,
      );

    it('answers 409 slug_taken for a server slug and for a hosted slug, leaving nothing behind', async () => {
      await t.pool.query(
        `insert into mcp_servers (slug, name, url, kind) values ('fx', 'fx', 'http://fx.example/mcp', 'system')
         on conflict (slug) do nothing`,
      );
      const n = await count();
      for (const slug of ['fx', 'fx2']) {
        const r = await post(body({ slug }));
        expect(r.statusCode, slug).toBe(409);
        expect(r.json()).toEqual({ error: 'slug_taken' });
      }
      expect(await count()).toBe(n);
    });

    it('answers 409 slug_taken for a hosted row that has no server row', async () => {
      await t.pool.query(
        `insert into hosted_servers (slug, image, port, cpu_limit, memory_limit, status)
         values ('orphan', 'fx-mcp:dev', 8080, '100m', '64Mi', 'deleting')`,
      );
      const r = await post(body({ slug: 'orphan' }));
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'slug_taken' });
      await t.pool.query(`delete from hosted_servers where slug = 'orphan'`);
    });

    it('answers 400 image_not_allowed with the allowed prefixes', async () => {
      const n = await count();
      const r = await post(body({ slug: 'bb', image: 'busybox:1.37' }));
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({
        error: 'image_not_allowed',
        allowedImagePrefixes: ['fx-mcp:'],
      });
      expect(await count()).toBe(n);
    });

    it.each([
      ['latest', { image: 'fx-mcp:latest' }],
      ['an untagged image', { image: 'fx-mcp' }],
      ['a prefix trick', { image: 'fx-mcp-evil:dev' }],
      ['cpu over the cap', { cpu: '600m' }],
      ['memory over the cap', { memory: '300Mi' }],
      ['a privileged port', { port: 80 }],
      ['a reserved env name', { env: [{ name: 'MCP_SHARED_TOKEN', value: 'x' }] }],
    ])('answers 400 for %s', async (_why, over) => {
      const n = await count();
      const r = await post(body({ slug: 'bad', ...over }));
      expect(r.statusCode).toBe(400);
      expect(['invalid_hosted', 'image_not_allowed']).toContain(r.json().error);
      expect(await count()).toBe(n);
    });

    it('answers invalid_hosted with issue paths and never echoes a submitted value', async () => {
      const r = await post(
        body({
          slug: 'bad',
          secretEnv: [{ name: 'bad name', value: SECRET }],
          'extra-key-ZZ': SECRET,
        }),
      );
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('invalid_hosted');
      expect(r.json().issues.length).toBeGreaterThan(0);
      expect(r.json().issues[0]).toHaveProperty('path');
      expect(r.body).not.toContain(SECRET);
      expect(r.body).not.toContain('extra-key-ZZ');
      expect(r.body).not.toContain('bad name');
    });
  });

  it('answers 409 hosted_unavailable when the provisioner is off', async () => {
    const off = await testApi('woo_api_hosted_off_test', { hosted });
    try {
      const a = await userWithSession(off.pool, 'admin@example.com', 'admin');
      const r = await call(off.app, 'POST', '/api/hosted', { cookie: a.cookie, body: body() });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'hosted_unavailable' });
      const g = await call(off.app, 'GET', '/api/hosted', { cookie: a.cookie });
      expect(g.statusCode).toBe(200);
      expect(g.json().servers).toEqual([]);
    } finally {
      await off.close();
    }
  });

  it('refuses every image when no prefix is configured', async () => {
    const none = await testApi('woo_api_hosted_none_test', {
      provisioner,
      hosted: { ...hosted, allowedImagePrefixes: [] },
    });
    try {
      const a = await userWithSession(none.pool, 'admin@example.com', 'admin');
      const r = await call(none.app, 'POST', '/api/hosted', { cookie: a.cookie, body: body() });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('image_not_allowed');
    } finally {
      await none.close();
    }
  });

  describe('delete', () => {
    it('sets deleting, deregisters the server and sends registry_changed and hosted_changed', async () => {
      const before = await row('fx2');
      const reg = await listen(t.url, 'registry_changed');
      const hos = await listen(t.url, 'hosted_changed');
      try {
        const r = await call(t.app, 'DELETE', `/api/hosted/${before.id}`, { cookie: admin.cookie });
        expect(r.statusCode).toBe(202);
        expect(r.json().server).toMatchObject({ slug: 'fx2', status: 'deleting' });
        expect(await reg.waitFor(1)).toEqual([before.sid]);
        expect(await hos.waitFor(1)).toEqual([before.id]);
      } finally {
        await reg.close();
        await hos.close();
      }
      const after = await row('fx2');
      expect(after.status).toBe('deleting');
      expect(after.sid).toBeNull();
      expect((await t.pool.query(`select 1 from mcp_servers where slug = 'fx2'`)).rowCount).toBe(0);
    });

    it('answers 202 to a second delete and 404 to an unknown or malformed id', async () => {
      const r0 = await row('fx2');
      const again = await call(t.app, 'DELETE', `/api/hosted/${r0.id}`, { cookie: admin.cookie });
      expect(again.statusCode).toBe(202);
      expect(again.json().server.status).toBe('deleting');
      const missing = await call(
        t.app,
        'DELETE',
        '/api/hosted/6b0c1e3a-5b4f-4f43-9c60-0d1f1a3c9a11',
        {
          cookie: admin.cookie,
        },
      );
      expect(missing.statusCode).toBe(404);
      const bad = await call(t.app, 'DELETE', '/api/hosted/not-an-id', { cookie: admin.cookie });
      expect(bad.statusCode).toBe(404);
    });

    it('deletes a row whose server row is already gone', async () => {
      const c = await post(body({ slug: 'solo' }));
      expect(c.statusCode).toBe(201);
      const id = c.json().server.id;
      await t.pool.query(`delete from mcp_servers where slug = 'solo'`);
      const r = await call(t.app, 'DELETE', `/api/hosted/${id}`, { cookie: admin.cookie });
      expect(r.statusCode).toBe(202);
    });
  });

  it('writes no secret value or token to the logs', async () => {
    const all = logs.join('');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(Buffer.from(SECRET).toString('base64'));
    const rows = (
      await t.pool.query(
        'select slug, secret_env_enc from hosted_servers where secret_env_enc is not null',
      )
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const blob = JSON.parse(decryptSecret(r.secret_env_enc, t.kek, `hosted:${r.slug}`)) as Record<
        string,
        string
      >;
      for (const v of Object.values(blob)) expect(all).not.toContain(v);
    }
  });
});
