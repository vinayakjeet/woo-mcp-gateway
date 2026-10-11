export function requireEnv<K extends string>(...names: K[]): Record<K, string> {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) throw new Error(`Missing env vars: ${missing.join(', ')}`);
  return Object.fromEntries(names.map((n) => [n, process.env[n]!])) as Record<K, string>;
}
