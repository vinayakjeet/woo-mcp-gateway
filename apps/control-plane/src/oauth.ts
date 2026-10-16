import rateLimit from '@fastify/rate-limit';
import { errorCode } from '@woo/core';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  insertDcrClient,
  parseRegistration,
  GRANT_TYPES,
  RESPONSE_TYPES,
} from './oauth-clients.js';
import { authorizeRoutes } from './oauth-authorize.js';
import { authorizationServerMetadata } from './oauth-metadata.js';

const METADATA_PATH = '/.well-known/oauth-authorization-server';
const REGISTER_PATH = '/oauth/register';

// These two read no cookie, so a forged cross-site request has nothing to ride on. The Origin check
// in app.ts skips them: native and browser clients send no Origin or a foreign one (decision 17).
export const OAUTH_ORIGIN_EXEMPT: ReadonlySet<string> = new Set([REGISTER_PATH, '/oauth/token']);

const REGISTER_PER_IP = 10;
const WINDOW = '1 minute';

export type OAuthOptions = {
  pool: pg.Pool;
  issuer: string;
  // JWT_SIGNING_KEY: the consent CSRF key is derived from it.
  jwtKey: string;
  // The gateway URL: the only `resource` a request may name (RFC 8707).
  resource: string;
};

export const pathOf = (url: string): string => url.split('?', 1)[0] ?? '';

// Registered only while OAUTH_ENABLED is true, so with the flag off every path here is a 404.
export async function oauthRoutes(scope: FastifyInstance, o: OAuthOptions): Promise<void> {
  await scope.register(rateLimit, { global: false });

  // Open CORS without credentials for the metadata and the two POST endpoints: a browser client such
  // as MCP Inspector calls them directly. /oauth/authorize is a navigation and gets none.
  const corsPaths = new Set([METADATA_PATH, REGISTER_PATH]);
  scope.addHook('onRequest', async (req, reply) => {
    if (corsPaths.has(pathOf(req.url))) reply.header('access-control-allow-origin', '*');
  });
  const preflight = (path: string, methods: string) =>
    scope.options(path, async (_req, reply) =>
      reply
        .code(204)
        .header('access-control-allow-methods', methods)
        .header('access-control-allow-headers', 'content-type, authorization, mcp-protocol-version')
        .header('access-control-max-age', '600')
        .send(),
    );
  preflight(METADATA_PATH, 'GET, OPTIONS');
  preflight(REGISTER_PATH, 'POST, OPTIONS');

  // OAuth errors are JSON with an error code (RFC 6749 5.2), and only the code is logged.
  scope.setErrorHandler((err: { statusCode?: number }, req, reply) => {
    const status =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    req.log.warn(
      { code: errorCode(err), route: req.routeOptions.url, status },
      'oauth request failed',
    );
    if (status === 429)
      return reply
        .code(429)
        .send({ error: 'temporarily_unavailable', error_description: 'Too many requests' });
    if (status === 500) return reply.code(500).send({ error: 'server_error' });
    return reply.code(status).send({ error: 'invalid_request' });
  });

  scope.get(METADATA_PATH, async () => authorizationServerMetadata(o.issuer));
  await authorizeRoutes(scope, o);

  scope.post(
    REGISTER_PATH,
    { bodyLimit: 16_384, config: { rateLimit: { max: REGISTER_PER_IP, timeWindow: WINDOW } } },
    async (req, reply) => {
      const r = parseRegistration(req.body);
      if (!r.ok) return reply.code(400).send({ error: r.error, error_description: r.description });
      const { clientId, issuedAt } = await insertDcrClient(o.pool, r);
      return reply
        .code(201)
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        .send({
          client_id: clientId,
          client_id_issued_at: issuedAt,
          client_name: r.name,
          redirect_uris: r.redirectUris,
          grant_types: [...GRANT_TYPES],
          response_types: [...RESPONSE_TYPES],
          token_endpoint_auth_method: 'none',
        });
    },
  );
}
