import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
  type Server,
} from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { Log } from './types.js';

export type FakeTool = (signal: AbortSignal) => Promise<CallToolResult>;

// A real MCP server over HTTP. Tools are read from the map on every request, so tests can change them.
// A rejected request gets a 401 whose body echoes the Authorization header, like a careless upstream.
export async function fakeUpstream(o: {
  tools: Map<string, FakeTool>;
  accept?: (req: http.IncomingMessage) => boolean;
  onRequest?: (req: http.IncomingMessage) => void;
  createServer?: () => McpServer | Server;
  port?: number;
}): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const handler = createMcpHandler(() => {
    if (o.createServer) return o.createServer();
    const s = new McpServer({ name: 'fake', version: '0.0.0' });
    for (const [name, fn] of o.tools) {
      s.registerTool(
        name,
        { description: `${name} tool`, inputSchema: z.object({}) },
        async (_args, ctx) => fn(ctx.mcpReq.signal),
      );
    }
    return s;
  });
  const node = toNodeHandler(handler);
  const server = http.createServer((req, res) => {
    o.onRequest?.(req);
    if (o.accept && !o.accept(req)) {
      res
        .writeHead(401, { 'content-type': 'text/plain' })
        .end(`rejected ${req.headers.authorization ?? ''}`);
      return;
    }
    void node(req, res);
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    close: async () => {
      await handler.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

export function captureLog(): Log & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (obj: object, msg: string) =>
    void lines.push(JSON.stringify({ level, ...obj, msg }));
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

export const quietLog: Log = { info: () => {}, warn: () => {}, error: () => {} };
