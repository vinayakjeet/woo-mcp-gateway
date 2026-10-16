import { randomUUID } from 'node:crypto';
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import {
  childTraceparent,
  errorCode,
  newTraceparent,
  parseTraceparent,
  type TraceParent,
} from '@woo/core';
import type { z } from 'zod';
import { canonicalJson, nestsDeeperThan, sha256Hex } from './canonical.js';
import { serverLabel, type GatewayMetrics } from './metrics.js';
import type { PolicyView } from './policies.js';
import type { CallLimiter } from './rate-limit.js';
import type { Router } from './registry.js';
import {
  CALL_TOOL,
  META_TOOLS,
  SEARCH_TOOLS,
  callToolInput,
  effectiveToolMode,
  searchTools,
  searchToolsInput,
} from './search.js';
import type { AuditRow, AuditSink, Log, Principal, ToolMode } from './types.js';

// Tool names come from the client: cap what is echoed back and stored.
export const MAX_NAME_ECHO = 128;
export const MAX_ERROR_MESSAGE = 500;
export const MAX_ARGS_DEPTH = 64;
export const MAX_VERSION_ECHO = 32;

// The SDK already answers 400 to an unknown version, but the audit row should not rely on that.
export const auditVersion = (raw: string | null | undefined): string | null =>
  raw ? raw.slice(0, MAX_VERSION_ECHO) : null;
// A limiter that stalls must not stall the call: past this the call goes through.
export const RATE_CHECK_TIMEOUT_MS = 2000;
export const LIST_CACHE_HINT = { ttlMs: 30_000, cacheScope: 'private' } as const;

export type GatewayServerOptions = {
  principal: Principal;
  // The URL override if the request had one, else the principal's mode (decided in app.ts).
  toolMode: ToolMode;
  router: Router;
  policies: PolicyView;
  audit: AuditSink;
  limiter: CallLimiter;
  // The HTTP request id, so the audit row, the log line and the x-request-id header agree.
  requestId?: string;
  metrics?: Pick<GatewayMetrics, 'observe'>;
  replica: string;
  log: Log;
  // Only a modern (2026-07-28) client can open subscriptions/listen, so only it is told the list can change.
  era?: 'legacy' | 'modern';
};

type MetaTool = AuditRow['metaTool'];

// The client's trace if it sent a valid one (_meta first, then the HTTP header), else a new one.
// Anything invalid is dropped, so client text never reaches a log line or an upstream.
export function traceFor(meta: unknown, header: string | null | undefined): TraceParent {
  const fromMeta = parseTraceparent((meta as { traceparent?: unknown } | undefined)?.traceparent);
  return fromMeta ?? parseTraceparent(header) ?? parseTraceparent(newTraceparent())!;
}

export function createGatewayServer(o: GatewayServerOptions): Server {
  const server = new Server(
    { name: 'woo-gateway', version: '0.1.0' },
    {
      capabilities: { tools: o.era === 'modern' ? { listChanged: true } : {} },
      cacheHints: { 'tools/list': LIST_CACHE_HINT },
    },
  );

  const allowed = (slug: string, tool: string) => o.policies.allows(o.principal.role, slug, tool);

  server.setRequestHandler('tools/list', () => {
    const visible = o.router.list(allowed);
    // SPEC 17: the mode is chosen after policy, so a member is counted on what they can see.
    return {
      tools: effectiveToolMode(o.toolMode, visible.length) === 'search' ? META_TOOLS : visible,
    };
  });

  const newRow = (name: string, protocolVersion: string | null, metaTool: MetaTool): AuditRow => ({
    requestId: o.requestId ?? randomUUID(),
    userId: o.principal.userId,
    userEmail: o.principal.email,
    via: o.principal.via,
    apiKeyId: o.principal.apiKeyId,
    serverId: null,
    serverSlug: '',
    toolName: name,
    exposedName: name,
    metaTool,
    outcome: 'bad_request',
    durationMs: 0,
    errorMessage: null,
    argsSha256: null,
    replica: o.replica,
    protocolVersion,
  });

  const writeAudit = async (row: AuditRow, started: number, trace: TraceParent) => {
    row.durationMs = Math.round(performance.now() - started);
    o.metrics?.observe(row);
    await o.audit
      .write(row)
      .catch((err: unknown) => o.log.error({ code: errorCode(err) }, 'audit write failed'));
    // Ids, names from our own registry, outcome and time only: never arguments, results or emails.
    // A name the registry did not resolve came from the client, so it is logged as _unknown.
    o.log.info(
      {
        request_id: row.requestId,
        trace_id: trace.traceId,
        user_id: row.userId,
        server: serverLabel(row),
        tool: row.serverId || row.metaTool === 'search_tools' ? row.toolName : '_unknown',
        outcome: row.outcome,
        ms: row.durationMs,
      },
      'tool call',
    );
  };

  // Seconds until the window resets when the caller is over the limit, else null. A broken or slow
  // limiter lets the call through: Postgres trouble should not turn into a second outage.
  const overLimit = async (): Promise<number | null> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const stall = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('rate limit check stalled'), { code: 'ETIMEDOUT' })),
          RATE_CHECK_TIMEOUT_MS,
        );
      });
      const r = await Promise.race([o.limiter.check(o.principal), stall]);
      return r.allowed ? null : r.retryInSeconds;
    } catch (err) {
      o.log.warn({ code: errorCode(err) }, 'rate limit check failed, letting the call through');
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const rateLimitedText = (retryInSeconds: number) =>
    `Rate limit exceeded, retry in ${retryInSeconds} s`;

  // A tree deeper than the limit would overflow the recursive canonicalJson.
  const hashArgs = (row: AuditRow, args: unknown) => {
    if (nestsDeeperThan(args, MAX_ARGS_DEPTH)) {
      row.errorMessage = 'arguments nested too deeply';
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Arguments are nested too deeply');
    }
    row.argsSha256 = sha256Hex(canonicalJson(args ?? {}));
  };

  // Issue paths and zod messages only: a message never repeats the submitted value.
  const invalidArguments = (row: AuditRow, tool: string, error: z.ZodError): ProtocolError => {
    const issues = error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`);
    const message = `Invalid arguments for ${tool}: ${issues.join('; ')}`.slice(
      0,
      MAX_ERROR_MESSAGE,
    );
    row.errorMessage = message;
    return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
  };

  // The one path for a tool call. A direct `tools/call` and `call_tool` both come through here, so
  // policy, the enabled flag, timeouts and the audit row cannot differ between them.
  const callRouted = async (
    rawName: string,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal,
    protocolVersion: string | null,
    metaTool: MetaTool,
    trace: TraceParent,
  ): Promise<CallToolResult> => {
    const started = performance.now();
    const name = rawName.slice(0, MAX_NAME_ECHO);
    const route = o.router.resolve(rawName);
    const [slugPart = '', ...rest] = name.split('__');
    const row = newRow(name, protocolVersion, metaTool);
    row.serverId = route?.upstream.record.id ?? null;
    row.serverSlug = route?.upstream.record.slug ?? (rest.length > 0 ? slugPart : '');
    row.toolName = route?.toolName ?? (rest.length > 0 ? rest.join('__') : name);
    const toolError = (message: string): CallToolResult => {
      row.errorMessage = message.slice(0, MAX_ERROR_MESSAGE);
      return { content: [{ type: 'text', text: message }], isError: true };
    };
    try {
      hashArgs(row, args);
      if (!route) {
        row.errorMessage = 'unknown tool';
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
      }
      const { record } = route.upstream;
      // Checked before the enabled flag, so a hidden tool says nothing about its server. The
      // message is the one a missing tool gets (SPEC 6.5 step 1).
      if (!allowed(record.slug, route.toolName)) {
        row.outcome = 'denied';
        row.errorMessage = 'hidden by policy';
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
      }
      // After policy, so a hidden tool is not counted; before the enabled flag (SPEC 6.5 step 2).
      const retry = await overLimit();
      if (retry !== null) {
        row.outcome = 'rate_limited';
        return toolError(rateLimitedText(retry));
      }
      if (!record.enabled) {
        row.outcome = 'disabled';
        return toolError(`Server ${record.slug} is disabled`);
      }
      row.outcome = 'upstream_error';
      const r = await route.upstream.call(route.toolName, args, signal, childTraceparent(trace));
      row.outcome = r.outcome;
      // As received (SPEC 6.5 step 6): projectCallToolResult could append a content block.
      if ('result' in r) return r.result;
      return toolError(r.message);
    } finally {
      await writeAudit(row, started, trace);
    }
  };

  const runSearch = async (
    args: Record<string, unknown> | undefined,
    protocolVersion: string | null,
    trace: TraceParent,
  ): Promise<CallToolResult> => {
    const started = performance.now();
    const row = newRow(SEARCH_TOOLS, protocolVersion, SEARCH_TOOLS);
    try {
      hashArgs(row, args);
      const parsed = searchToolsInput.safeParse(args ?? {});
      if (!parsed.success) throw invalidArguments(row, SEARCH_TOOLS, parsed.error);
      const retry = await overLimit();
      if (retry !== null) {
        row.outcome = 'rate_limited';
        row.errorMessage = rateLimitedText(retry);
        return { content: [{ type: 'text', text: row.errorMessage }], isError: true };
      }
      // The same filter as tools/list, so search never shows what the caller could not list.
      const found = searchTools(o.router.list(allowed), parsed.data.query, parsed.data.limit);
      const payload = {
        tools: found.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      };
      row.outcome = 'ok';
      // Many clients pass only the text block to the model, so it carries the same JSON.
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    } finally {
      await writeAudit(row, started, trace);
    }
  };

  const runCallTool = async (
    args: Record<string, unknown> | undefined,
    signal: AbortSignal,
    protocolVersion: string | null,
    trace: TraceParent,
  ): Promise<CallToolResult> => {
    const parsed = callToolInput.safeParse(args ?? {});
    if (!parsed.success) {
      const started = performance.now();
      const row = newRow(CALL_TOOL, protocolVersion, CALL_TOOL);
      try {
        hashArgs(row, args);
        throw invalidArguments(row, CALL_TOOL, parsed.error);
      } finally {
        await writeAudit(row, started, trace);
      }
    }
    // The inner call writes the audit row: one row per tools/call (SPEC 9), naming the real tool.
    return callRouted(
      parsed.data.name,
      parsed.data.arguments,
      signal,
      protocolVersion,
      CALL_TOOL,
      trace,
    );
  };

  server.setRequestHandler('tools/call', (req, ctx) => {
    const version = auditVersion(ctx.http?.req?.headers.get('mcp-protocol-version'));
    const signal = ctx.mcpReq.signal;
    const trace = traceFor(req.params._meta, ctx.http?.req?.headers.get('traceparent'));
    // Meta-tools work in every mode: under `auto` a client that listed in search mode must keep
    // working if the count falls to 40 before its next call.
    if (req.params.name === SEARCH_TOOLS) return runSearch(req.params.arguments, version, trace);
    if (req.params.name === CALL_TOOL)
      return runCallTool(req.params.arguments, signal, version, trace);
    return callRouted(req.params.name, req.params.arguments, signal, version, null, trace);
  });

  return server;
}
