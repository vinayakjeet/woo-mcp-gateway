import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { traceIdOf } from './trace.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest();

// Hash both sides so timingSafeEqual gets equal lengths and the comparison time does not depend on the token.
export function checkBearer(header: string | undefined, token: string): boolean {
  const m = /^Bearer (\S+)$/i.exec(header ?? '');
  return m?.[1] !== undefined && timingSafeEqual(sha256(m[1]), sha256(token));
}

const READY_TIMEOUT_MS = 2000;

export type ToolCallLog = (line: Record<string, unknown>) => void;

const jsonLine: ToolCallLog = (line) => console.log(JSON.stringify(line));

// One line per tool call with the tool name, the caller's trace id and the time. Never arguments,
// results or error messages: those can hold customer data. Call it on a new McpServer before any
// registerTool, so both upstream servers share one code path without touching each tool.
export function logToolCalls(server: McpServer, log: ToolCallLog = jsonLine): McpServer {
  const register = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (
    name: string,
    config: unknown,
    cb: (...a: unknown[]) => unknown,
  ) =>
    register(name, config, async (...a: unknown[]) => {
      const started = performance.now();
      const ctx = a.at(-1) as { mcpReq?: { _meta?: { traceparent?: unknown } } } | undefined;
      try {
        return await cb(...a);
      } finally {
        log({
          level: 'info',
          msg: 'tool call',
          tool: name,
          trace_id: traceIdOf(ctx?.mcpReq?._meta?.traceparent),
          ms: Math.round(performance.now() - started),
        });
      }
    });
  return server;
}

async function isReady(ready: () => Promise<boolean>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>(
    (resolve) => (timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS)),
  );
  try {
    return await Promise.race([ready().catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startMcpHttpServer(opts: {
  port: number;
  token: string;
  createServer: () => McpServer;
  ready: () => Promise<boolean>;
}) {
  const handler = createMcpHandler(() => opts.createServer());
  const mcp = toNodeHandler(handler);
  const send = (res: http.ServerResponse, status: number, text: string) => {
    res.writeHead(status, { 'content-type': 'text/plain' }).end(text);
  };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/healthz') return send(res, 200, 'ok');
    if (path === '/readyz') {
      void isReady(opts.ready).then((ok) => send(res, ok ? 200 : 503, ok ? 'ready' : 'not ready'));
      return;
    }
    if (path !== '/mcp') return send(res, 404, 'not found');
    if (!checkBearer(req.headers.authorization, opts.token)) {
      res.setHeader('www-authenticate', 'Bearer');
      return send(res, 401, 'unauthorized');
    }
    mcp(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'internal error');
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    // Unlike close, this leaves in-flight requests alone. installGracefulShutdown bounds the wait.
    shutdown: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await handler.close();
    },
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
