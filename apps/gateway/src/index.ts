import { installGracefulShutdown } from '@woo/core';
import { loadConfig, type GatewayConfig } from './config.js';
import { startGateway } from './main.js';

let cfg: GatewayConfig;
try {
  cfg = loadConfig(process.env);
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: (err as Error).message }));
  process.exit(1);
}

const gateway = await startGateway(cfg);

installGracefulShutdown({ servers: gateway.servers, close: gateway.close });
