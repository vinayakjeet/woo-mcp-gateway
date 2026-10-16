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
  // Lets external upstreams use http. Off unless the chart sets it to the string "true".
  allowInsecureUpstreams: boolean;
  // Calls per minute for a key without its own limit, and for the agent.
  rateLimitPerMinute: number;
  oauthEnabled: boolean;
  // The authorization server origin, set only while oauthEnabled.
  oauthIssuer: string | null;
};

const REQUIRED = [
  'DATABASE_URL',
  'KEK',
  'API_KEY_PEPPER',
  'JWT_SIGNING_KEY',
  'GATEWAY_URL',
] as const;

function parseRateLimit(raw: string | undefined): number {
  if (raw === undefined) return 60;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error('RATE_LIMIT_PER_MINUTE must be a whole number of 1 or more');
  return n;
}

// An issuer is an origin with no path, query or userinfo, so it can be compared as a string.
function parseIssuer(raw: string | undefined): string {
  if (!raw) throw new Error('OAUTH_ISSUER is required when OAUTH_ENABLED is true');
  const bad = new Error('OAUTH_ISSUER must be an origin such as https://app.example.com');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw bad;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== raw) throw bad;
  return raw;
}

// Errors name variables only, never values.
export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const missing = REQUIRED.filter((n) => !env[n]);
  if (missing.length > 0) throw new Error(`Missing env vars: ${missing.join(', ')}`);
  const oauthEnabled = env.OAUTH_ENABLED === 'true';
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
    allowInsecureUpstreams: env.ALLOW_INSECURE_UPSTREAMS === 'true',
    rateLimitPerMinute: parseRateLimit(env.RATE_LIMIT_PER_MINUTE),
    oauthEnabled,
    oauthIssuer: oauthEnabled ? parseIssuer(env.OAUTH_ISSUER) : null,
  };
}
