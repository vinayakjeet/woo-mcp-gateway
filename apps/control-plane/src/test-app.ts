import { randomBytes } from 'node:crypto';
import { generateSessionToken } from '@woo/core';
import type { FastifyInstance, FastifyServerOptions, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { apiRoutes, type ApiOptions } from './api.js';
import { buildPublicApp } from './app.js';
import { migrateAndSeed } from './migrate-run.js';
import { pgDeps } from './repo.js';
import { freshDatabase } from './test-db.js';

export const ORIGIN = 'http://app.127.0.0.1.nip.io';
export const TEST_PEPPER = 'test-pepper';
export const ADMIN_PASSWORD = 'pw-admin-12345';

// Built the same way as index.ts, so the routes inherit the real Origin check and error handler.
export async function testApi(
  dbName: string,
  over: Partial<ApiOptions> = {},
  logger: FastifyServerOptions['logger'] = false,
) {
  const url = await freshDatabase(process.env.TEST_DATABASE_URL!, dbName);
  const kek = randomBytes(32);
  await migrateAndSeed({
    databaseUrl: url,
    kek,
    adminEmail: 'admin@example.com',
    adminPassword: ADMIN_PASSWORD,
    seedServers: [],
  });
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const app = buildPublicApp(pgDeps(pool), { appOrigin: ORIGIN, secureCookies: false }, logger);
  await app.register(apiRoutes, {
    pool,
    appOrigin: ORIGIN,
    secureCookies: false,
    pepper: TEST_PEPPER,
    kek,
    gatewayUrl: 'http://mcp.127.0.0.1.nip.io/mcp',
    version: 'test',
    ...over,
  });
  await app.ready();
  return {
    app,
    pool,
    url,
    kek,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  o: { cookie?: string; body?: unknown; origin?: string | null } = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {};
  if (o.cookie) headers.cookie = o.cookie;
  if (method !== 'GET' && o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  return app.inject({
    method,
    url,
    headers,
    ...(o.body !== undefined ? { payload: JSON.stringify(o.body) } : {}),
  });
}

// Skips argon2: the user and session rows are written directly.
export async function userWithSession(
  pool: pg.Pool,
  email: string,
  role: 'admin' | 'member' = 'member',
): Promise<{ id: string; cookie: string }> {
  const u = await pool.query<{ id: string }>(
    `insert into users (email, role, status) values ($1, $2, 'active')
     on conflict (email) do update set role = excluded.role returning id`,
    [email, role],
  );
  const id = u.rows[0]!.id;
  const { token, tokenHash } = generateSessionToken();
  await pool.query(
    `insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 hour')`,
    [id, tokenHash],
  );
  return { id, cookie: `sid=${token}` };
}

export async function listen(url: string, channel: 'key_revoked' | 'registry_changed') {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const got: string[] = [];
  c.on('notification', (n) => {
    if (n.channel === channel) got.push(n.payload ?? '');
  });
  await c.query(`LISTEN ${channel}`);
  return {
    got,
    // Delivery is asynchronous after commit, so poll briefly instead of sleeping a fixed time.
    async waitFor(n: number, ms = 1000): Promise<string[]> {
      const end = Date.now() + ms;
      while (got.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      return got;
    },
    close: () => c.end(),
  };
}

export async function rawKey(pool: pg.Pool, userId: string, revoked = false): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `insert into api_keys (user_id, name, prefix, secret_hash, revoked_at)
     values ($1, 'raw', $2, 'x', $3) returning id`,
    [userId, randomBytes(4).toString('hex'), revoked ? new Date() : null],
  );
  return r.rows[0]!.id;
}
