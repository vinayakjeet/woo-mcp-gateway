import { decryptSecret, LOG_REDACT } from '@woo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, listen, ORIGIN, testApi, userWithSession } from './test-app.js';

const SECRET = 'ghp-test-SECRET-value-123';
const gh = (over: Record<string, unknown> = {}) => ({
  name: 'GitHub',
  slug: 'gh',
  url: 'https://api.githubcopilot.com/mcp/',
  auth: { type: 'bearer', secret: SECRET },
  ...over,
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'servers API: create and list (needs TEST_DATABASE_URL)',
  () => {
    let t: Awaited<ReturnType<typeof testApi>>;
    let admin: { id: string; cookie: string };
    let member: { id: string; cookie: string };
    const lines: string[] = [];
    beforeAll(async () => {
      t = await testApi(
        'woo_api_servers_test',
        { checkUrl: async (u) => (u.includes('169.254.') ? 'link-local address' : null) },
        {
          level: 'trace',
          redact: LOG_REDACT,
          stream: { write: (s: string) => void lines.push(s) },
        },
      );
      admin = await userWithSession(t.pool, 'admin@example.com', 'admin');
      member = await userWithSession(t.pool, 'member@example.com');
    });
    afterAll(async () => {
      await t.close();
    });

    const post = (body: unknown, cookie = admin.cookie) =>
      call(t.app, 'POST', '/api/servers', { cookie, body });

    it('creates an external server, encrypts the secret with the slug as AAD and notifies', async () => {
      const l = await listen(t.url, 'registry_changed');
      try {
        const r = await post(gh());
        expect(r.statusCode).toBe(201);
        const s = r.json().server;
        expect(s).toMatchObject({
          slug: 'gh',
          kind: 'external',
          managed: false,
          enabled: true,
          protocolMode: 'legacy',
          timeoutMs: 15000,
          auth: { type: 'bearer', headerName: null, hasSecret: true },
          status: null,
          tools: [],
        });
        expect(await l.waitFor(1)).toEqual([s.id]);
        const row = await t.pool.query('select auth_secret_enc from mcp_servers where id = $1', [
          s.id,
        ]);
        expect(decryptSecret(row.rows[0].auth_secret_enc, t.kek, 'gh')).toBe(SECRET);
        expect(() => decryptSecret(row.rows[0].auth_secret_enc, t.kek, 'other')).toThrow();
      } finally {
        await l.close();
      }
    });

    it('never returns or logs the secret, also when the request fails', async () => {
      const bad = await post(gh({ slug: 'gh2', url: 'ftp://x' }));
      const taken = await post(gh());
      const broken = await t.app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: { cookie: admin.cookie, origin: ORIGIN, 'content-type': 'application/json' },
        payload: `{"auth":{"secret":"${SECRET}"`,
      });
      expect([bad.statusCode, taken.statusCode, broken.statusCode]).toEqual([400, 409, 400]);
      for (const r of [bad, taken, broken]) expect(r.body).not.toContain(SECRET);
      const list = await call(t.app, 'GET', '/api/servers', { cookie: admin.cookie });
      expect(list.body).not.toContain(SECRET);
      expect(list.body).not.toContain('auth_secret');
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join('\n')).not.toContain(SECRET);
    });

    it('answers a taken slug with 409 and no notify', async () => {
      const l = await listen(t.url, 'registry_changed');
      try {
        expect((await post(gh())).json()).toEqual({ error: 'slug_taken' });
        expect(await l.waitFor(1, 300)).toEqual([]);
      } finally {
        await l.close();
      }
    });

    it('names slug and secret problems and refuses fields the API owns', async () => {
      expect((await post(gh({ slug: 'a' }))).json()).toEqual({ error: 'invalid_slug' });
      expect((await post(gh({ slug: 'kindy', kind: 'system' }))).json()).toEqual({
        error: 'bad_request',
      });
      expect((await post(gh({ slug: 'nosecret', auth: { type: 'bearer' } }))).json()).toEqual({
        error: 'secret_required',
      });
    });

    it('runs the URL check before writing anything', async () => {
      const r = await post(gh({ slug: 'meta', url: 'http://169.254.169.254/latest' }));
      expect(r.json()).toEqual({ error: 'url_rejected', reason: 'link-local address' });
      expect((await t.pool.query(`select 1 from mcp_servers where slug = 'meta'`)).rowCount).toBe(
        0,
      );
    });

    it('lists servers with gateway status and live tools to every signed-in user', async () => {
      const created = await post(
        gh({
          slug: 'withtools',
          protocolMode: 'auto',
          auth: { type: 'header', headerName: 'X-Api-Key', secret: 's' },
        }),
      );
      const id = created.json().server.id as string;
      await t.pool.query(
        `insert into mcp_server_status (server_id, state, tool_count, checked_at)
       values ($1, 'connected', 1, now())`,
        [id],
      );
      await t.pool.query(
        `insert into mcp_tools (server_id, name, exposed_name, description, input_schema, annotations,
         definition_hash, state)
       values ($1, 'b_tool', 'withtools__b_tool', 'B', '{}', '{"readOnlyHint": true}', 'h1', 'active'),
              ($1, 'gone', 'withtools__gone', 'G', '{}', null, 'h2', 'removed')`,
        [id],
      );
      const r = await call(t.app, 'GET', '/api/servers', { cookie: member.cookie });
      expect(r.statusCode).toBe(200);
      const s = r.json().servers.find((x: { id: string }) => x.id === id);
      expect(s).toMatchObject({
        protocolMode: 'auto',
        auth: { type: 'header', headerName: 'X-Api-Key', hasSecret: true },
        status: { state: 'connected', toolCount: 1 },
        tools: [{ exposedName: 'withtools__b_tool', description: 'B', readOnly: true }],
      });
      expect((await call(t.app, 'GET', '/api/servers')).statusCode).toBe(401);
    });

    it('is admin only for writes and keeps the Origin check', async () => {
      expect((await post(gh({ slug: 'memberwrite' }), member.cookie)).statusCode).toBe(403);
      const noOrigin = await call(t.app, 'POST', '/api/servers', {
        cookie: admin.cookie,
        origin: null,
        body: gh({ slug: 'noorigin' }),
      });
      expect(noOrigin.statusCode).toBe(403);
    });
  },
);
