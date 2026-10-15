import { installGracefulShutdown } from '@woo/core';
import { startMcpHttpServer } from '@woo/core/mcp-http';
import { Frankfurter } from './frankfurter.js';
import { buildFxServer } from './tools.js';

const token = process.env.MCP_SHARED_TOKEN;
if (!token) throw new Error('Missing env vars: MCP_SHARED_TOKEN');
const fx = new Frankfurter({ baseUrl: process.env.FX_BASE_URL });
// Ready once listening and never checks Frankfurter: during an outage tool calls
// answer from cache, so the pod must stay in the Service.
const { url, server, shutdown } = await startMcpHttpServer({
  port: Number(process.env.PORT ?? 8080),
  token,
  createServer: buildFxServer({ fx }),
  ready: async () => true,
});
console.log(JSON.stringify({ level: 'info', msg: 'fx-mcp listening', url }));
// A full EUR table in cache lets an outage soon after start still answer any latest pair.
void fx.warm((code) =>
  console.log(JSON.stringify({ level: 'warn', msg: 'fx cache warm-up failed', code })),
);
installGracefulShutdown({ servers: [server], close: shutdown });
