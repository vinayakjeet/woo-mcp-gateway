import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { inviteRoutes } from './api-invites.js';
import { userRoutes } from './api-users.js';
import { sessionRoutes, sessionUser, sidFromCookie } from './api-session.js';

export type ApiOptions = {
  pool: pg.Pool;
  appOrigin: string;
  secureCookies: boolean;
  pepper: string;
  kek: Buffer;
  gatewayUrl: string;
  version: string;
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
}
