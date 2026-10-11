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

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void gateway.close().finally(() => process.exit(0));
  });
}
