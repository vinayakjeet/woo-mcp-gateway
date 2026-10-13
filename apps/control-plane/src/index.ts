import { installGracefulShutdown, LOG_REDACT, parseKek } from '@woo/core';
import pg from 'pg';
import { apiRoutes } from './api.js';
import { buildInternalApp, buildPublicApp } from './app.js';
import { requireEnv } from './env.js';
import { introspectRoutes } from './internal-introspect.js';
import { pgDeps } from './repo.js';
import { provisionerConfig } from './store-values.js';

const env = requireEnv(
  'DATABASE_URL',
  'APP_ORIGIN',
  'API_KEY_PEPPER',
  'KEK',
  'GATEWAY_URL',
  'JWT_SIGNING_KEY',
  'INTERNAL_SECRET',
);
const kek = parseKek(env.KEK);
const provisioner = provisionerConfig(process.env);
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
  kek,
  provisioner,
  gatewayUrl: env.GATEWAY_URL,
  version: process.env.APP_VERSION ?? 'dev',
});
const internal = buildInternalApp(deps, logger);
// The agent JWT audience is the gateway's public URL, the same GATEWAY_URL the gateway checks.
await internal.register(introspectRoutes, {
  pool,
  internalSecret: env.INTERNAL_SECRET,
  jwtKey: env.JWT_SIGNING_KEY,
  gatewayUrl: env.GATEWAY_URL,
});

await pub.listen({ host: '0.0.0.0', port: Number(process.env.PUBLIC_PORT ?? 3000) });
await internal.listen({ host: '0.0.0.0', port: Number(process.env.INTERNAL_PORT ?? 3001) });

installGracefulShutdown({
  servers: [pub.server, internal.server],
  close: async () => {
    await Promise.all([pub.close(), internal.close()]);
    await pool.end();
  },
});
