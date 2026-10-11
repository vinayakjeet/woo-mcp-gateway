import { hostname } from 'node:os';
import { parseKek } from '@woo/core';

export type GatewayConfig = {
  databaseUrl: string;
  kek: Buffer;
  pepper: string;
  jwtKey: string;
  audience: string;
  replica: string;
  allowedOrigins: string[];
  port: number;
  healthPort: number;
};

const REQUIRED = [
  'DATABASE_URL',
  'KEK',
  'API_KEY_PEPPER',
  'JWT_SIGNING_KEY',
  'GATEWAY_URL',
] as const;

// Errors name variables only, never values.
export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const missing = REQUIRED.filter((n) => !env[n]);
  if (missing.length > 0) throw new Error(`Missing env vars: ${missing.join(', ')}`);
  return {
    databaseUrl: env.DATABASE_URL!,
    kek: parseKek(env.KEK!),
    pepper: env.API_KEY_PEPPER!,
    jwtKey: env.JWT_SIGNING_KEY!,
    audience: env.GATEWAY_URL!,
    replica: env.POD_NAME || hostname(),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    port: Number(env.PORT ?? 8080),
    healthPort: Number(env.HEALTH_PORT ?? 9090),
  };
}
