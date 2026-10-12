import { verifyAgentJwt } from '@woo/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInternalApp } from './app.js';
import { introspectRoutes } from './internal-introspect.js';
import { pgDeps } from './repo.js';
import { testApi, userWithSession } from './test-app.js';

const SECRET = 'internal-secret-for-tests';
const JWT_KEY = 'jwt-key-for-tests';
const GATEWAY_URL = 'http://mcp.127.0.0.1.nip.io/mcp';

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'POST /internal/sessions/introspect (needs TEST_DATABASE_URL)',
  () => {
    let t: Awaited<ReturnType<typeof testApi>>;
    let internal: FastifyInstance;
    beforeAll(async () => {
      t = await testApi('woo_introspect_test');
      internal = buildInternalApp(pgDeps(t.pool));
      await internal.register(introspectRoutes, {
        pool: t.pool,
        internalSecret: SECRET,
        jwtKey: JWT_KEY,
        gatewayUrl: GATEWAY_URL,
      });
      await internal.ready();
    });
    afterAll(async () => {
      await internal.close();
      await t.close();
    });

    const introspect = (headers: Record<string, string>) =>
      internal.inject({ method: 'POST', url: '/internal/sessions/introspect', headers });

    it('returns the user and an agent JWT for the gateway audience', async () => {
      const u = await userWithSession(t.pool, 'agent-user@example.com');
      const before = Math.floor(Date.now() / 1000);
      const r = await introspect({
        'x-internal-secret': SECRET,
        cookie: `theme=dark; ${u.cookie}`,
      });
      expect(r.statusCode).toBe(200);
      const body = r.json<{ user: unknown; token: string; expiresAt: string }>();
      expect(body.user).toEqual({
        id: u.id,
        email: 'agent-user@example.com',
        name: null,
        role: 'member',
      });
      const claims = verifyAgentJwt(body.token, { key: JWT_KEY, audience: GATEWAY_URL });
      expect(claims.sub).toBe(u.id);
      expect(claims.act).toEqual({ sub: 'agent' });
      expect(claims.exp - claims.iat).toBe(300);
      expect(claims.iat).toBeGreaterThanOrEqual(before);
      expect(Date.parse(body.expiresAt) / 1000).toBe(claims.exp);
    });

    it('answers 403 without the internal secret or with a wrong one', async () => {
      const u = await userWithSession(t.pool, 'agent-user2@example.com');
      const cases: Record<string, string>[] = [
        { cookie: u.cookie },
        { cookie: u.cookie, 'x-internal-secret': 'wrong' },
      ];
      for (const headers of cases) {
        const r = await introspect(headers);
        expect([r.statusCode, r.json()]).toEqual([403, { error: 'forbidden' }]);
      }
    });

    it('answers 401 without a live session', async () => {
      const expired = await userWithSession(t.pool, 'agent-user3@example.com');
      await t.pool.query(
        `update sessions set expires_at = now() - interval '1 second' where user_id = $1`,
        [expired.id],
      );
      const disabled = await userWithSession(t.pool, 'agent-user4@example.com');
      await t.pool.query(`update users set status = 'disabled' where id = $1`, [disabled.id]);
      for (const cookie of [undefined, `sid=${'a'.repeat(43)}`, expired.cookie, disabled.cookie]) {
        const r = await introspect({ 'x-internal-secret': SECRET, ...(cookie ? { cookie } : {}) });
        expect([r.statusCode, r.json()]).toEqual([401, { error: 'unauthenticated' }]);
      }
    });
  },
);
