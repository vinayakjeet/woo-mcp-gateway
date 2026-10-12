import { randomUUID } from 'node:crypto';
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import { errorCode } from '@woo/core';
import { canonicalJson, nestsDeeperThan, sha256Hex } from './canonical.js';
import type { Router } from './registry.js';
import type { AuditRow, AuditSink, Log, Principal } from './types.js';

// Tool names come from the client: cap what is echoed back and stored.
export const MAX_NAME_ECHO = 128;
export const MAX_ERROR_MESSAGE = 500;
export const MAX_ARGS_DEPTH = 64;
export const MAX_VERSION_ECHO = 32;

// The SDK already answers 400 to an unknown version, but the audit row should not rely on that.
export const auditVersion = (raw: string | null | undefined): string | null =>
  raw ? raw.slice(0, MAX_VERSION_ECHO) : null;
export const LIST_CACHE_HINT = { ttlMs: 30_000, cacheScope: 'private' } as const;

export type GatewayServerOptions = {
  principal: Principal;
  router: Router;
  audit: AuditSink;
  replica: string;
  log: Log;
};

export function createGatewayServer(o: GatewayServerOptions): Server {
  const server = new Server(
    { name: 'woo-gateway', version: '0.1.0' },
    { capabilities: { tools: {} }, cacheHints: { 'tools/list': LIST_CACHE_HINT } },
  );

  server.setRequestHandler('tools/list', () => ({ tools: o.router.list() }));

  server.setRequestHandler('tools/call', async (req, ctx) => {
    const started = performance.now();
    const name = req.params.name.slice(0, MAX_NAME_ECHO);
    const args = req.params.arguments;
    const route = o.router.resolve(req.params.name);
    const [slugPart = '', ...rest] = name.split('__');
    const row: AuditRow = {
      requestId: randomUUID(),
      userId: o.principal.userId,
      userEmail: o.principal.email,
      via: o.principal.via,
      apiKeyId: o.principal.apiKeyId,
      serverId: route?.upstream.record.id ?? null,
      serverSlug: route?.upstream.record.slug ?? (rest.length > 0 ? slugPart : ''),
      toolName: route?.toolName ?? (rest.length > 0 ? rest.join('__') : name),
      exposedName: name,
      outcome: 'bad_request',
      durationMs: 0,
      errorMessage: null,
      argsSha256: null,
      replica: o.replica,
      protocolVersion: auditVersion(ctx.http?.req?.headers.get('mcp-protocol-version')),
    };
    const toolError = (message: string): CallToolResult => {
      row.errorMessage = message.slice(0, MAX_ERROR_MESSAGE);
      return { content: [{ type: 'text', text: message }], isError: true };
    };
    try {
      // A tree deeper than the limit would overflow the recursive canonicalJson.
      if (nestsDeeperThan(args, MAX_ARGS_DEPTH)) {
        row.errorMessage = 'arguments nested too deeply';
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Arguments are nested too deeply');
      }
      row.argsSha256 = sha256Hex(canonicalJson(args ?? {}));
      if (!route) {
        row.errorMessage = 'unknown tool';
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
      }
      const { record } = route.upstream;
      if (!record.enabled) {
        row.outcome = 'disabled';
        return toolError(`Server ${record.slug} is disabled`);
      }
      row.outcome = 'upstream_error';
      const r = await route.upstream.call(route.toolName, args, ctx.mcpReq.signal);
      row.outcome = r.outcome;
      // As received (SPEC 6.5 step 6): projectCallToolResult could append a content block.
      if ('result' in r) return r.result;
      return toolError(r.message);
    } finally {
      row.durationMs = Math.round(performance.now() - started);
      await o.audit
        .write(row)
        .catch((err: unknown) => o.log.error({ code: errorCode(err) }, 'audit write failed'));
    }
  });

  return server;
}
