import { startMcpHttpServer } from '@woo/core/mcp-http';
import { loadConfig } from './config.js';
import { buildWooServer } from './tools.js';
import { WooClient } from './woo-client.js';

const cfg = loadConfig(process.env);
const woo = new WooClient(cfg.woo);
const { url } = await startMcpHttpServer({
  port: cfg.port,
  token: cfg.token,
  createServer: buildWooServer({ woo }),
  ready: async () => {
    await woo.index();
    return true;
  },
});
console.log(JSON.stringify({ level: 'info', msg: 'woo-mcp listening', url }));
