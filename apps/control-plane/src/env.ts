import { parseOAuthIssuer } from '@woo/core';

export function requireEnv<K extends string>(...names: K[]): Record<K, string> {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) throw new Error(`Missing env vars: ${missing.join(', ')}`);
  return Object.fromEntries(names.map((n) => [n, process.env[n]!])) as Record<K, string>;
}

// OAuth is on only for the exact string "true" (decision 20). The issuer is read only then.
export function oauthEnv(
  env: NodeJS.ProcessEnv,
): { enabled: false; issuer: null } | { enabled: true; issuer: string } {
  if (env.OAUTH_ENABLED !== 'true') return { enabled: false, issuer: null };
  return { enabled: true, issuer: parseOAuthIssuer(env.OAUTH_ISSUER) };
}
