import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { approvalRoutes } from './api-approvals.js';
import { auditRoutes } from './api-audit.js';
import { hostedRoutes } from './api-hosted.js';
import { inviteRoutes } from './api-invites.js';
import { keyRoutes } from './api-keys.js';
import { grantRoutes } from './oauth-grants.js';
import { policyRoutes } from './api-policies.js';
import { userRoutes } from './api-users.js';
import { serverRoutes } from './api-servers.js';
import { statsRoutes } from './api-stats.js';
import { storeRoutes } from './api-stores.js';
import { sessionRoutes, sessionUser, sidFromCookie } from './api-session.js';
import type { HostedConfig } from './hosted-input.js';
import type { UrlCheck } from './ssrf.js';
import type { ProvisionerConfig } from './store-values.js';

export type ApiOptions = {
  pool: pg.Pool;
  appOrigin: string;
  secureCookies: boolean;
  pepper: string;
  kek: Buffer;
  gatewayUrl: string;
  version: string;
  // Lets the dashboard show the OAuth connect command only when the flow exists.
  oauthEnabled?: boolean;
  checkUrl?: UrlCheck;
  // Null when provisioner.enabled is false: the Stores page lists, creates answer 503.
  provisioner?: ProvisionerConfig | null;
  // Allowlist and caps for hosted servers. Unset means no image is allowed.
  hosted?: HostedConfig;
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
  if (o.oauthEnabled) grantRoutes(scope, o);
  serverRoutes(scope, o);
  approvalRoutes(scope, o);
  policyRoutes(scope, o);
  storeRoutes(scope, o);
  hostedRoutes(scope, o);
  auditRoutes(scope, o);
  statsRoutes(scope, o);
}
