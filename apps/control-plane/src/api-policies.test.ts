import { SEED_POLICIES } from '@woo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, listen, testApi, userWithSession } from './test-app.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('policies API (needs TEST_DATABASE_URL)', () => {
  let t: Awaited<ReturnType<typeof testApi>>;
  let admin: { id: string; cookie: string };
  let member: { id: string; cookie: string };
  beforeAll(async () => {
    t = await testApi('woo_api_policies_test');
    admin = await userWithSession(t.pool, 'admin@example.com', 'admin');
    member = await userWithSession(t.pool, 'member@example.com');
  });
  afterAll(async () => {
    await t.close();
  });

  const rule = (over: Record<string, unknown> = {}) => ({
    role: 'member',
    serverPattern: 'main',
    toolPattern: 'list_orders',
    effect: 'deny',
    priority: 10,
    ...over,
  });
  const post = (body: unknown, cookie = admin.cookie) =>
    call(t.app, 'POST', '/api/policies', { cookie, body });
  const list = async (cookie = member.cookie) =>
    (await call(t.app, 'GET', '/api/policies', { cookie })).json().policies as Array<
      Record<string, unknown>
    >;

  it('lists the seeded rules in evaluation order for a member', async () => {
    const r = await call(t.app, 'GET', '/api/policies', { cookie: member.cookie });
    expect(r.statusCode).toBe(200);
    const rules = r.json().policies as Array<{ id: string; priority: number }>;
    expect(rules).toHaveLength(SEED_POLICIES.length);
    expect(rules[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        role: expect.any(String),
        serverPattern: expect.any(String),
        toolPattern: expect.any(String),
        effect: 'allow',
        priority: 0,
        createdAt: expect.any(String),
      }),
    );
    expect((await call(t.app, 'GET', '/api/policies')).statusCode).toBe(401);
  });

  it('orders by priority, highest first', async () => {
    const low = await post(rule({ priority: -5, effect: 'allow', toolPattern: 'order_a' }));
    const high = await post(rule({ priority: 500, effect: 'allow', toolPattern: 'order_b' }));
    const rules = await list();
    expect(rules[0]?.id).toBe(high.json().policy.id);
    expect(rules.at(-1)?.id).toBe(low.json().policy.id);
    for (const r of [low, high]) {
      await call(t.app, 'DELETE', `/api/policies/${r.json().policy.id}`, {
        cookie: admin.cookie,
      });
    }
  });

  it('refuses writes from a member', async () => {
    expect((await post(rule(), member.cookie)).statusCode).toBe(403);
    const id = (await list())[0]?.id;
    const del = await call(t.app, 'DELETE', `/api/policies/${id}`, { cookie: member.cookie });
    expect(del.statusCode).toBe(403);
    expect(await list()).toHaveLength(SEED_POLICIES.length);
  });

  it('validates patterns and answers 400 invalid_policy', async () => {
    for (const bad of [
      rule({ serverPattern: '' }),
      rule({ toolPattern: 'a b' }),
      rule({ serverPattern: 'a'.repeat(25) }),
      rule({ priority: 1001 }),
      rule({ role: 'owner' }),
      'not an object',
    ]) {
      const r = await post(bad);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('invalid_policy');
    }
  });

  it('answers 201 with the rule and sends NOTIFY policies_changed', async () => {
    const l = await listen(t.url, 'policies_changed');
    try {
      const r = await post(rule({ toolPattern: 'created_rule' }));
      expect(r.statusCode).toBe(201);
      const p = r.json().policy;
      expect(p).toMatchObject(rule({ toolPattern: 'created_rule' }));
      expect(await l.waitFor(1)).toEqual([p.id]);
      const del = await call(t.app, 'DELETE', `/api/policies/${p.id}`, { cookie: admin.cookie });
      expect(del.statusCode).toBe(204);
      expect(await l.waitFor(2)).toEqual([p.id, p.id]);
    } finally {
      await l.close();
    }
  });

  it('defaults priority to 0', async () => {
    const noPriority: Record<string, unknown> = rule({ toolPattern: 'default_prio' });
    delete noPriority.priority;
    const r = await post(noPriority);
    expect(r.statusCode).toBe(201);
    expect(r.json().policy.priority).toBe(0);
    await call(t.app, 'DELETE', `/api/policies/${r.json().policy.id}`, { cookie: admin.cookie });
  });

  it('answers 409 policy_exists for an exact duplicate and sends no NOTIFY', async () => {
    const first = await post(rule({ toolPattern: 'dup' }));
    expect(first.statusCode).toBe(201);
    const l = await listen(t.url, 'policies_changed');
    try {
      const again = await post(rule({ toolPattern: 'dup' }));
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe('policy_exists');
      // Same pattern with another effect is a different rule.
      const other = await post(rule({ toolPattern: 'dup', effect: 'allow' }));
      expect(other.statusCode).toBe(201);
      expect(await l.waitFor(2)).toHaveLength(1);
      await call(t.app, 'DELETE', `/api/policies/${other.json().policy.id}`, {
        cookie: admin.cookie,
      });
    } finally {
      await l.close();
    }
    await call(t.app, 'DELETE', `/api/policies/${first.json().policy.id}`, {
      cookie: admin.cookie,
    });
  });

  it('answers DELETE 204 and then 404, also for a malformed id', async () => {
    const p = (await post(rule({ toolPattern: 'to_delete' }))).json().policy;
    const url = `/api/policies/${p.id}`;
    expect((await call(t.app, 'DELETE', url, { cookie: admin.cookie })).statusCode).toBe(204);
    expect((await call(t.app, 'DELETE', url, { cookie: admin.cookie })).statusCode).toBe(404);
    const bad = await call(t.app, 'DELETE', '/api/policies/nope', { cookie: admin.cookie });
    expect(bad.statusCode).toBe(404);
  });

  it('refuses state changes without a matching Origin', async () => {
    const r = await call(t.app, 'POST', '/api/policies', {
      cookie: admin.cookie,
      body: rule({ toolPattern: 'no_origin' }),
      origin: null,
    });
    expect(r.statusCode).toBe(403);
    const wrong = await call(t.app, 'POST', '/api/policies', {
      cookie: admin.cookie,
      body: rule({ toolPattern: 'no_origin' }),
      origin: 'http://evil.example',
    });
    expect(wrong.statusCode).toBe(403);
    expect((await list()).some((x) => x.toolPattern === 'no_origin')).toBe(false);
  });

  describe('roles on GET /api/servers', () => {
    const tools = async () => {
      const r = await call(t.app, 'GET', '/api/servers', { cookie: member.cookie });
      const main = (
        r.json().servers as Array<{ slug: string; tools: Array<Record<string, unknown>> }>
      ).find((s) => s.slug === 'main');
      return Object.fromEntries((main?.tools ?? []).map((x) => [x.exposedName as string, x]));
    };

    beforeAll(async () => {
      const s = await t.pool.query<{ id: string }>(
        `insert into mcp_servers (slug, name, url, kind, managed)
           values ('main', 'Main', 'http://x', 'store', true) returning id`,
      );
      await t.pool.query(
        `insert into mcp_tools (server_id, name, exposed_name, input_schema, definition_hash, state)
           values ($1, 'list_orders', 'main__list_orders', '{}', 'h1', 'active'),
                  ($1, 'create_product', 'main__create_product', '{}', 'h2', 'active'),
                  ($1, 'old_tool', 'main__old_tool', '{}', 'h3', 'removed')`,
        [s.rows[0]!.id],
      );
    });

    it('shows state and the roles that may use each tool under the seed', async () => {
      const x = await tools();
      expect(x['main__list_orders']).toMatchObject({ state: 'active', roles: ['admin', 'member'] });
      expect(x['main__create_product']).toMatchObject({ state: 'active', roles: ['admin'] });
      expect(x['main__old_tool']).toBeUndefined();
    });

    it('changes after a member deny rule is added and after it is removed', async () => {
      const p = (
        await post(rule({ serverPattern: 'main', toolPattern: 'list_orders', priority: 10 }))
      ).json().policy;
      expect((await tools())['main__list_orders']).toMatchObject({ roles: ['admin'] });
      await call(t.app, 'DELETE', `/api/policies/${p.id}`, { cookie: admin.cookie });
      expect((await tools())['main__list_orders']).toMatchObject({ roles: ['admin', 'member'] });
    });
  });
});
