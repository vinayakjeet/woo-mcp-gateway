import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { auditRoutes } from './api-audit.js';
import { inviteRoutes } from './api-invites.js';
import { keyRoutes } from './api-keys.js';
import { userRoutes } from './api-users.js';
import { serverRoutes } from './api-servers.js';
import { sessionRoutes, sessionUser, sidFromCookie } from './api-session.js';
import type { UrlCheck } from './ssrf.js';

export type ApiOptions = {
  pool: pg.Pool;
  appOrigin: string;
  secureCookies: boolean;
  pepper: string;
  kek: Buffer;
  gatewayUrl: string;
  version: string;
  checkUrl?: UrlCheck;
};

// Registered on buildPublicApp's root, so every route here inherits the Origin check and the
// error handler that logs only error codes.
export async function apiRoutes(scope: FastifyInstance, o: ApiOptions): Promise<void> {
  scope.decorateRequest('user', null);
  scope.addHook('onRequest', async (req) => {
    const sid = sidFromCookie(req.headers.cookie);
    req.user = sid ? await sessionUser(o.pool, sid) : null;
  });
  sessionRoutes(scope, o);
  inviteRoutes(scope, o);
  userRoutes(scope, o);
  keyRoutes(scope, o);
  serverRoutes(scope, o);
  auditRoutes(scope, o);
}
