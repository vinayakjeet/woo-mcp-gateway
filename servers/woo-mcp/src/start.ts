import { startMcpHttpServer } from '@woo/core/mcp-http';
import { loadConfig } from './config.js';
import { buildWooServer } from './tools.js';
import { WooClient } from './woo-client.js';

export async function startWooMcp(env: NodeJS.ProcessEnv) {
  const cfg = loadConfig(env);
  const woo = new WooClient(cfg.woo);
  return startMcpHttpServer({
    port: cfg.port,
    token: cfg.token,
    createServer: buildWooServer({ woo }),
    // Config loaded and the process serving is all "ready" means. A probe on WooCommerce would
    // deadlock a fresh install: the bootstrap hook that installs the site runs only after Helm's
    // --wait sees this pod ready. The provisioner checks that the store works (reconcile verify).
    ready: async () => true,
  });
}
