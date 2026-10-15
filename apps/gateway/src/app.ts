import type { IncomingMessage } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { errorCode, requestIdOptions } from '@woo/core';
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
  replica: string;
  allowedOrigins: string[];
  logger?: FastifyServerOptions['logger'];
  // A seam for tests that watch which options the server gets.
  createServer?: (options: GatewayServerOptions) => ReturnType<typeof createGatewayServer>;
};

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
    if (origin !== undefined && !allowed.has(origin)) {
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
      if (!principal) return reply.code(401).send(rpcError(-32001, 'Unauthorized'));
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
