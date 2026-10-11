import { startMcpHttpServer } from '@woo/core/mcp-http';
import { Frankfurter } from './frankfurter.js';
import { buildFxServer } from './tools.js';

const token = process.env.MCP_SHARED_TOKEN;
if (!token) throw new Error('Missing env vars: MCP_SHARED_TOKEN');
const fx = new Frankfurter({ baseUrl: process.env.FX_BASE_URL });
// Ready once listening: a Frankfurter outage must fail tool calls, not remove the pod from the Service.
const { url } = await startMcpHttpServer({
  port: Number(process.env.PORT ?? 8080),
  token,
  createServer: buildFxServer({ fx }),
  ready: async () => true,
});
console.log(JSON.stringify({ level: 'info', msg: 'fx-mcp listening', url }));
