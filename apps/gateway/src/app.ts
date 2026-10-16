import type { IncomingMessage } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  type AuthInfo,
  type OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/server';
import { OAUTH_SCOPE, errorCode, requestIdOptions } from '@woo/core';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { createGatewayServer, type GatewayServerOptions } from './mcp.js';
import { parseToolModeOverride } from './search.js';
import type { GatewayMetrics } from './metrics.js';
import type { PolicyView } from './policies.js';
import type { CallLimiter } from './rate-limit.js';
import type { Router } from './registry.js';
import type { AuditSink, Log, Principal } from './types.js';

export type GatewayAppOptions = {
  router: Router;
  policies: PolicyView;
  audit: AuditSink;
  limiter: CallLimiter;
  metrics?: Pick<GatewayMetrics, 'observe'>;
  authenticate(header: string | undefined): Promise<Principal | null>;
  // Set only while OAuth is on (SPEC 24): `resource` is GATEWAY_URL, `issuer` the authorization server origin.
  oauth?: { resource: string; issuer: string };
  replica: string;
  allowedOrigins: string[];
  logger?: FastifyServerOptions['logger'];
  // A seam for tests that watch which options the server gets.
  createServer?: (options: GatewayServerOptions) => ReturnType<typeof createGatewayServer>;
};

const PRM_ROOT = '/.well-known/oauth-protected-resource';

const rpcError = (code: number, message: string) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id: null,
});

export function buildGatewayApp(o: GatewayAppOptions): FastifyInstance {
  // Ids are ours alone: a client header cannot choose what appears in the logs or the audit log.
  const app = Fastify({ logger: o.logger ?? false, ...requestIdOptions });
  const log: Log = app.log;
  const allowed = new Set(o.allowedOrigins);

  // The root path is SPEC 24 and the target of WWW-Authenticate. The path-aware one is RFC 9728 and
  // what the SDK helper builds for a resource with a path, so both answer.
  let prmPaths: ReadonlySet<string> | null = null;
  let challenge: ((tokenSent: boolean) => string) | null = null;
  if (o.oauth) {
    const { resource, issuer } = o.oauth;
    prmPaths = new Set([
      PRM_ROOT,
      new URL(getOAuthProtectedResourceMetadataUrl(new URL(resource))).pathname,
    ]);
    const prm: OAuthProtectedResourceMetadata = {
      resource,
      authorization_servers: [issuer],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Urumi MCP gateway',
    };
    const metadataUrl = `${new URL(resource).origin}${PRM_ROOT}`;
    // error="invalid_token" only when a bearer token was sent, so a client knows to refresh it.
    challenge = (tokenSent) =>
      `Bearer ${tokenSent ? 'error="invalid_token", ' : ''}resource_metadata="${metadataUrl}", scope="${OAUTH_SCOPE}"`;
    for (const path of prmPaths) {
      app.get(path, async (_req, reply) =>
        reply.header('access-control-allow-origin', '*').send(prm),
      );
      app.options(path, async (_req, reply) =>
        reply
          .code(204)
          .header('access-control-allow-origin', '*')
          .header('access-control-allow-methods', 'GET, OPTIONS')
          .header(
            'access-control-allow-headers',
            'content-type, authorization, mcp-protocol-version',
          )
          .header('access-control-max-age', '600')
          .send(),
      );
    }
  }

  const handler = createMcpHandler(
    (ctx) => {
      const principal = ctx.authInfo?.extra?.principal as Principal | undefined;
      if (!principal) throw new Error('request reached the MCP handler without a principal');
      const override = ctx.authInfo?.extra?.toolModeOverride as 'search' | 'full' | undefined;
      return (o.createServer ?? createGatewayServer)({
        principal,
        toolMode: override ?? principal.toolMode,
        router: o.router,
        policies: o.policies,
        audit: o.audit,
        limiter: o.limiter,
        metrics: o.metrics,
        requestId: ctx.authInfo?.extra?.requestId as string | undefined,
        replica: o.replica,
        log,
      });
    },
    {
      keepAliveMs: 25_000,
      onerror: (err) => log.warn({ code: errorCode(err) }, 'mcp request rejected'),
    },
  );
  const mcp = toNodeHandler(handler, {
    onerror: (err) => log.error({ code: errorCode(err) }, 'mcp adapter failed'),
  });

  // Leave the body unread: the SDK reads it itself and owns parse errors (-32700), 415 and the size limit.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, _payload, done) => done(null));

  app.addHook('onRequest', async (req, reply) => {
    // setHeader on the raw response, so hijacked SDK responses carry it too.
    reply.raw.setHeader('x-gateway-replica', o.replica);
    reply.raw.setHeader('x-request-id', req.id);
    const origin = req.headers.origin;
    // Public metadata: a browser client reads it from any page, and it carries no credentials.
    const publicMetadata =
      prmPaths?.has(req.url.split('?', 1)[0] ?? '') &&
      (req.method === 'GET' || req.method === 'OPTIONS');
    if (origin !== undefined && !publicMetadata && !allowed.has(origin)) {
      return reply.code(403).send(rpcError(-32000, 'Origin not allowed'));
    }
  });

  app.route({
    method: ['POST', 'GET', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      let principal: Principal | null;
      try {
        principal = await o.authenticate(req.headers.authorization);
      } catch (err) {
        log.error({ code: errorCode(err) }, 'authentication failed');
        return reply.code(503).send(rpcError(-32603, 'Authentication unavailable'));
      }
      if (!principal) {
        if (challenge)
          reply.header(
            'www-authenticate',
            challenge(/^Bearer \S+$/i.test(req.headers.authorization ?? '')),
          );
        return reply.code(401).send(rpcError(-32001, 'Unauthorized'));
      }
      // After authentication, so an unknown caller learns nothing about accepted values.
      let toolModeOverride: 'search' | 'full' | undefined;
      try {
        toolModeOverride = parseToolModeOverride((req.query as Record<string, unknown>).toolMode);
      } catch {
        return reply.code(400).send(rpcError(-32602, 'Invalid toolMode'));
      }
      // authInfo is pass-through to the server factory. The token field stays empty so no credential travels on.
      const auth: AuthInfo = {
        token: '',
        clientId: principal.userId,
        scopes: [],
        extra: { principal, toolModeOverride, requestId: req.id },
      };
      (req.raw as IncomingMessage & { auth?: AuthInfo }).auth = auth;
      reply.raw.setHeader('x-accel-buffering', 'no');
      reply.hijack();
      await mcp(req.raw, reply.raw).catch((err: unknown) =>
        log.error({ code: errorCode(err) }, 'mcp handler failed'),
      );
    },
  });

  app.addHook('onClose', async () => {
    await handler.close();
  });

  return app;
}
