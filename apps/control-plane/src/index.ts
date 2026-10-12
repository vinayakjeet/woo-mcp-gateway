import { installGracefulShutdown, LOG_REDACT, parseKek } from '@woo/core';
import pg from 'pg';
import { apiRoutes } from './api.js';
import { buildInternalApp, buildPublicApp } from './app.js';
import { requireEnv } from './env.js';
import { pgDeps } from './repo.js';

const env = requireEnv('DATABASE_URL', 'APP_ORIGIN', 'API_KEY_PEPPER', 'KEK', 'GATEWAY_URL');
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
const deps = pgDeps(pool);
const logger = { redact: LOG_REDACT };
const secureCookies = env.APP_ORIGIN.startsWith('https://');

const pub = buildPublicApp(deps, { appOrigin: env.APP_ORIGIN, secureCookies }, logger);
await pub.register(apiRoutes, {
  pool,
  appOrigin: env.APP_ORIGIN,
  secureCookies,
  pepper: env.API_KEY_PEPPER,
  kek: parseKek(env.KEK),
  gatewayUrl: env.GATEWAY_URL,
  version: process.env.APP_VERSION ?? 'dev',
});
const internal = buildInternalApp(deps, logger);

await pub.listen({ host: '0.0.0.0', port: Number(process.env.PUBLIC_PORT ?? 3000) });
await internal.listen({ host: '0.0.0.0', port: Number(process.env.INTERNAL_PORT ?? 3001) });

installGracefulShutdown({
  servers: [pub.server, internal.server],
  close: async () => {
    await Promise.all([pub.close(), internal.close()]);
    await pool.end();
  },
});
