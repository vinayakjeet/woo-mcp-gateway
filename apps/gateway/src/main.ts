import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorCode, pinnedFetch } from '@woo/core';
import { schema, schemaReady } from '@woo/core/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyServerOptions } from 'fastify';
import pg from 'pg';
import { buildGatewayApp } from './app.js';
import { PgAuditSink } from './audit-db.js';
import { Authenticator } from './auth.js';
import type { GatewayConfig } from './config.js';
import { buildHealthApp } from './health.js';
import { createGatewayMetrics } from './metrics.js';
import { ListenHub } from './listen.js';
import { gatewayLogger } from './logger.js';
import { PG_CONNECT_TIMEOUT_MS, PG_QUERY_TIMEOUT_MS } from './pg-options.js';
import { PolicyStore } from './policies.js';
import { callLimiter, RateLimiter } from './rate-limit.js';
import { Registry, type RegistryOptions } from './registry.js';
import { StatusWriter } from './status.js';
import { GatewaySync } from './sync.js';

export type StartOptions = {
  host?: string;
  logger?: FastifyServerOptions['logger'];
  upstream?: RegistryOptions['upstream'];
  schemaPollMs?: number;
  // How often open listen streams are authenticated again. Tests shorten it.
  listenRecheckMs?: number;
};

export async function startGateway(cfg: GatewayConfig, o: StartOptions = {}) {
  const host = o.host ?? '0.0.0.0';
  const logger = o.logger ?? gatewayLogger;
  const pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: 5,
    connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS,
    query_timeout: PG_QUERY_TIMEOUT_MS,
  });
  const db = drizzle(pool, { schema });

  const health = buildHealthApp(
    {
      ready: async () => sync.loaded && (await schemaReady(pool)),
      metrics: () => metrics.render(),
    },
    logger,
  );
  const log = health.log;
  const auth = new Authenticator({
    db,
    pepper: cfg.pepper,
    jwtKey: cfg.jwtKey,
    audience: cfg.audience,
    oauthIssuer: cfg.oauthIssuer ?? undefined,
    log,
  });
  const writeStatus = (
    u: Parameters<StatusWriter['write']>[0] & { record: { slug: string } },
    changed: boolean,
  ) =>
    void status
      .write(u, changed)
      .catch((err: unknown) =>
        log.warn({ server: u.record.slug, code: errorCode(err) }, 'status write failed'),
      );
  const registry = new Registry({
    log,
    upstream: {
      externalFetch: pinnedFetch({ allowInsecure: cfg.allowInsecureUpstreams }),
      ...o.upstream,
    },
    onTools: (u) => sync.persistTools(u),
    onStatus: writeStatus,
  });
  const metrics = createGatewayMetrics(registry);
  // A new status writer has never written this replica's view, including disabled servers that never check.
  const status = new StatusWriter({
    databaseUrl: cfg.databaseUrl,
    db,
    log,
    onElected: () => registry.upstreams().forEach((u) => writeStatus(u, true)),
  });
  const policies = new PolicyStore(db);
  const sync = new GatewaySync({
    databaseUrl: cfg.databaseUrl,
    db,
    kek: cfg.kek,
    registry,
    auth,
    policies,
    log,
    onToolsChanged: () => listen.toolsChanged(),
  });
  const listen = new ListenHub({
    authenticate: (h) => auth.authenticate(h),
    log,
    recheckMs: o.listenRecheckMs,
  });
  const app = buildGatewayApp({
    router: registry,
    policies,
    audit: new PgAuditSink(db),
    limiter: callLimiter(new RateLimiter(db), cfg.rateLimitPerMinute),
    metrics,
    authenticate: (h) => auth.authenticate(h),
    listen,
    oauth: cfg.oauthIssuer ? { resource: cfg.audience, issuer: cfg.oauthIssuer } : undefined,
    replica: cfg.replica,
    allowedOrigins: cfg.allowedOrigins,
    logger,
  });

  await health.listen({ host, port: cfg.healthPort });
  // The control-plane's init container migrates. Until then readiness stays 503 and nothing loads.
  while (!(await schemaReady(pool).catch(() => false))) await sleep(o.schemaPollMs ?? 2000);
  await sync.start();
  await status.start();
  await app.listen({ host, port: cfg.port });

  const portOf = (s: { address(): unknown }) => (s.address() as AddressInfo).port;
  return {
    port: portOf(app.server),
    healthPort: portOf(health.server),
    servers: [app.server, health.server],
    close: async () => {
      await app.close();
      listen.close();
      await health.close();
      await sync.close();
      await status.close();
      await registry.close();
      await pool.end();
    },
  };
}
