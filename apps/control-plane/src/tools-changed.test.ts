import { encryptSecret } from '@woo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, listen, testApi, userWithSession } from './test-app.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('tools_changed (needs TEST_DATABASE_URL)', () => {
  let t: Awaited<ReturnType<typeof testApi>>;
  let admin: { id: string; cookie: string };
  beforeAll(async () => {
    t = await testApi('woo_tools_changed_test');
    admin = await userWithSession(t.pool, 'admin@example.com', 'admin');
  });
  afterAll(async () => {
    await t.close();
  });

  // Every change that can alter a client's tool list sends tools_changed in the transaction of the
  // change. The payload is empty on purpose: it is a hint to list again, and names no server.
  const rule = {
    role: 'member',
    serverPattern: 'main',
    toolPattern: 'tc_rule',
    effect: 'deny',
    priority: 10,
  };
  async function server(slug: string, approval: 'approved' | 'pending' = 'approved') {
    const r = await t.pool.query<{ id: string }>(
      `insert into mcp_servers (slug, name, url, kind, managed, approval, auth_type, auth_secret_enc)
       values ($1, $1, 'https://x.example/mcp', 'external', false, $2, 'bearer', $3) returning id`,
      [slug, approval, encryptSecret('s', t.kek, slug)],
    );
    return r.rows[0]!.id;
  }
  async function hears<T>(act: () => Promise<T>, n = 1): Promise<{ out: T; got: string[] }> {
    const l = await listen(t.url, 'tools_changed');
    try {
      const out = await act();
      await l.waitFor(n);
      // Leave time for a second NOTIFY that should not be there.
      await new Promise((r) => setTimeout(r, 150));
      return { out, got: [...l.got] };
    } finally {
      await l.close();
    }
  }

  it('creating a policy sends tools_changed with an empty payload', async () => {
    const { out, got } = await hears(() =>
      call(t.app, 'POST', '/api/policies', { cookie: admin.cookie, body: rule }),
    );
    expect(out.statusCode).toBe(201);
    expect(got).toEqual(['']);
  });

  it('deleting a policy sends tools_changed', async () => {
    const created = await call(t.app, 'POST', '/api/policies', {
      cookie: admin.cookie,
      body: { ...rule, toolPattern: 'tc_delete' },
    });
    const id = created.json().policy.id;
    const { out, got } = await hears(() =>
      call(t.app, 'DELETE', `/api/policies/${id}`, { cookie: admin.cookie }),
    );
    expect(out.statusCode).toBe(204);
    expect(got).toEqual(['']);
  });

  it('a duplicate policy is refused and sends nothing', async () => {
    const { out, got } = await hears(
      () => call(t.app, 'POST', '/api/policies', { cookie: admin.cookie, body: rule }),
      0,
    );
    expect(out.statusCode).toBe(409);
    expect(got).toEqual([]);
  });

  it('approving a server sends tools_changed', async () => {
    const id = await server('tc-approve', 'pending');
    const { out, got } = await hears(() =>
      call(t.app, 'POST', `/api/servers/${id}/approve`, { cookie: admin.cookie, body: {} }),
    );
    expect(out.statusCode).toBe(200);
    expect(got).toEqual(['']);
  });

  it('disabling a server sends tools_changed', async () => {
    const id = await server('tc-disable');
    const { out, got } = await hears(() =>
      call(t.app, 'PATCH', `/api/servers/${id}`, {
        cookie: admin.cookie,
        body: { enabled: false },
      }),
    );
    expect(out.statusCode).toBe(200);
    expect(got).toEqual(['']);
  });

  it('deleting a server sends tools_changed', async () => {
    const id = await server('tc-delete');
    const { out, got } = await hears(() =>
      call(t.app, 'DELETE', `/api/servers/${id}`, { cookie: admin.cookie }),
    );
    expect(out.statusCode).toBe(204);
    expect(got).toEqual(['']);
  });

  it('reads send nothing', async () => {
    const { got } = await hears(async () => {
      await call(t.app, 'GET', '/api/policies', { cookie: admin.cookie });
      await call(t.app, 'GET', '/api/servers', { cookie: admin.cookie });
    }, 0);
    expect(got).toEqual([]);
  });
});
