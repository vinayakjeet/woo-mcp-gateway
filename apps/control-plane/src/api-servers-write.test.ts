import { decryptSecret } from '@woo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, listen, testApi, userWithSession } from './test-app.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'servers API: writes (needs TEST_DATABASE_URL)',
  () => {
    let t: Awaited<ReturnType<typeof testApi>>;
    let admin: { id: string; cookie: string };
    let member: { id: string; cookie: string };
    beforeAll(async () => {
      t = await testApi('woo_api_servers_write_test');
      admin = await userWithSession(t.pool, 'admin@example.com', 'admin');
      member = await userWithSession(t.pool, 'member@example.com');
    });
    afterAll(async () => {
      await t.close();
    });

    const create = async (slug: string, over: Record<string, unknown> = {}) => {
      const r = await call(t.app, 'POST', '/api/servers', {
        cookie: admin.cookie,
        body: {
          name: slug,
          slug,
          url: `http://${slug}.example/mcp`,
          auth: { type: 'bearer', secret: 'first' },
          ...over,
        },
      });
      return r.json().server.id as string;
    };
    const managed = async (slug: string) =>
      (
        await t.pool.query<{ id: string }>(
          `insert into mcp_servers (slug, name, url, kind, managed)
         values ($1, $1, 'http://m.example/mcp', 'system', true) returning id`,
          [slug],
        )
      ).rows[0]!.id;
    const patch = (id: string, body: unknown, cookie = admin.cookie) =>
      call(t.app, 'PATCH', `/api/servers/${id}`, { cookie, body });
    const del = (id: string, cookie = admin.cookie) =>
      call(t.app, 'DELETE', `/api/servers/${id}`, { cookie });
    const stored = async (id: string) =>
      (await t.pool.query('select auth_secret_enc from mcp_servers where id = $1', [id])).rows[0]
        .auth_secret_enc as Buffer | null;

    it('creates an external server as pending approval', async () => {
      const r = await call(t.app, 'POST', '/api/servers', {
        cookie: admin.cookie,
        body: {
          name: 'New',
          slug: 'newpend',
          url: 'http://newpend.example/mcp',
          auth: { type: 'none' },
        },
      });
      expect(r.statusCode).toBe(201);
      expect(r.json().server).toMatchObject({ kind: 'external', approval: 'pending' });
    });

    it('sets an approved server back to pending when its url changes, not when its name does', async () => {
      const id = await create('repoint');
      await t.pool.query("update mcp_servers set approval = 'approved' where id = $1", [id]);
      expect((await patch(id, { name: 'Renamed' })).json().server.approval).toBe('approved');
      const same = await patch(id, { url: 'http://repoint.example/mcp' });
      expect(same.json().server.approval).toBe('approved');
      const moved = await patch(id, { url: 'http://elsewhere.example/mcp' });
      expect(moved.json().server.approval).toBe('pending');
    });

    it('disables and re-enables with a notify each time', async () => {
      const id = await create('tog');
      const l = await listen(t.url, 'registry_changed');
      try {
        expect((await patch(id, { enabled: false })).json().server.enabled).toBe(false);
        expect((await patch(id, { enabled: true })).json().server.enabled).toBe(true);
        expect(await l.waitFor(2)).toEqual([id, id]);
      } finally {
        await l.close();
      }
    });

    it('edits name, url, timeout and protocol, never the slug', async () => {
      const id = await create('edit');
      const r = await patch(id, {
        name: 'Edited',
        url: 'https://edit.example/mcp',
        timeoutMs: 30000,
        protocolMode: 'auto',
      });
      expect(r.json().server).toMatchObject({
        slug: 'edit',
        name: 'Edited',
        url: 'https://edit.example/mcp',
        timeoutMs: 30000,
        protocolMode: 'auto',
      });
      expect((await patch(id, { slug: 'renamed' })).json()).toEqual({ error: 'slug_immutable' });
      expect((await patch(id, { slug: 'renamed', name: 'x' })).statusCode).toBe(400);
      const row = await t.pool.query('select slug, name from mcp_servers where id = $1', [id]);
      expect(row.rows[0]).toEqual({ slug: 'edit', name: 'Edited' });
    });

    it('keeps the secret unless one is typed, and clears it for auth none', async () => {
      const id = await create('sec');
      const before = (await stored(id))!;
      const kept = await patch(id, { auth: { type: 'bearer' } });
      expect(kept.json().server.auth).toEqual({
        type: 'bearer',
        headerName: null,
        hasSecret: true,
      });
      expect(Buffer.compare(before, (await stored(id))!)).toBe(0);
      const replaced = await patch(id, {
        auth: { type: 'header', headerName: 'X-Api-Key', secret: 'second' },
      });
      expect(replaced.json().server.auth).toEqual({
        type: 'header',
        headerName: 'X-Api-Key',
        hasSecret: true,
      });
      expect(replaced.body).not.toContain('second');
      expect(decryptSecret((await stored(id))!, t.kek, 'sec')).toBe('second');
      const none = await patch(id, { auth: { type: 'none' } });
      expect(none.json().server.auth).toEqual({ type: 'none', headerName: null, hasSecret: false });
      expect(await stored(id)).toBeNull();
      expect((await patch(id, { auth: { type: 'bearer' } })).json()).toEqual({
        error: 'secret_required',
      });
    });

    it('sends no notify when a change fails', async () => {
      const id = await create('nofail', { auth: { type: 'none' } });
      const l = await listen(t.url, 'registry_changed');
      try {
        expect((await patch(id, { auth: { type: 'bearer' } })).statusCode).toBe(400);
        expect((await patch(id, { url: 'ftp://x' })).statusCode).toBe(400);
        expect(await l.waitFor(1, 300)).toEqual([]);
      } finally {
        await l.close();
      }
    });

    it('lets a managed server be disabled or retimed, nothing else, and never removed', async () => {
      const id = await managed('mgd');
      expect((await patch(id, { enabled: false })).json().server.enabled).toBe(false);
      expect((await patch(id, { timeoutMs: 20000 })).json().server.timeoutMs).toBe(20000);
      for (const body of [
        { url: 'http://other.example/mcp' },
        { name: 'x' },
        { auth: { type: 'none' } },
        { protocolMode: 'auto' },
        { enabled: true, name: 'x' },
      ]) {
        expect((await patch(id, body)).json()).toEqual({ error: 'managed_server' });
      }
      expect((await del(id)).json()).toEqual({ error: 'managed_server' });
      expect((await t.pool.query('select 1 from mcp_servers where id = $1', [id])).rowCount).toBe(
        1,
      );
    });

    it('deletes an external server with its status and tools, and notifies', async () => {
      const id = await create('del');
      await t.pool.query(
        `insert into mcp_server_status (server_id, state) values ($1, 'connected')`,
        [id],
      );
      await t.pool.query(
        `insert into mcp_tools (server_id, name, exposed_name, input_schema, definition_hash)
       values ($1, 't', 'del__t', '{}', 'h')`,
        [id],
      );
      const l = await listen(t.url, 'registry_changed');
      try {
        expect((await del(id)).statusCode).toBe(204);
        expect(await l.waitFor(1)).toEqual([id]);
      } finally {
        await l.close();
      }
      for (const [table, col] of [
        ['mcp_servers', 'id'],
        ['mcp_server_status', 'server_id'],
        ['mcp_tools', 'server_id'],
      ] as const) {
        expect(
          (await t.pool.query(`select 1 from ${table} where ${col} = $1`, [id])).rowCount,
        ).toBe(0);
      }
    });

    it('answers malformed and unknown ids with 404', async () => {
      for (const id of ['abc', '00000000-0000-4000-8000-000000000000']) {
        expect((await patch(id, { enabled: false })).statusCode).toBe(404);
        expect((await del(id)).statusCode).toBe(404);
      }
    });

    it('is admin only and keeps the Origin check', async () => {
      const id = await create('guard');
      expect((await patch(id, { enabled: false }, member.cookie)).statusCode).toBe(403);
      expect((await del(id, member.cookie)).statusCode).toBe(403);
      const p = await call(t.app, 'PATCH', `/api/servers/${id}`, {
        cookie: admin.cookie,
        origin: null,
        body: { enabled: false },
      });
      const d = await call(t.app, 'DELETE', `/api/servers/${id}`, {
        cookie: admin.cookie,
        origin: null,
      });
      expect([p.statusCode, d.statusCode]).toEqual([403, 403]);
    });
  },
);
