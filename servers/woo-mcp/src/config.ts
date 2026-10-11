import type { WooConfig } from './woo-client.js';

const REQUIRED = [
  'MCP_SHARED_TOKEN',
  'WC_BASE_URL',
  'WC_SIGNING_BASE_URL',
  'WC_CONSUMER_KEY',
  'WC_CONSUMER_SECRET',
] as const;

export function loadConfig(env: NodeJS.ProcessEnv): {
  port: number;
  token: string;
  woo: WooConfig;
} {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`Missing env vars: ${missing.join(', ')}`);
  return {
    port: Number(env.PORT ?? 8080),
    token: env.MCP_SHARED_TOKEN!,
    woo: {
      baseUrl: env.WC_BASE_URL!,
      signingBaseUrl: env.WC_SIGNING_BASE_URL!,
      consumerKey: env.WC_CONSUMER_KEY!,
      consumerSecret: env.WC_CONSUMER_SECRET!,
    },
  };
}
