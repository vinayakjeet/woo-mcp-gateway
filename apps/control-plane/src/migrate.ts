import { parseKek } from '@woo/core';
import { requireEnv } from './env.js';
import { migrateAndSeed } from './migrate-run.js';
import { parseSeedServers } from './seed.js';

try {
  const env = requireEnv('DATABASE_URL', 'KEK', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SEED_SERVERS');
  const servers = parseSeedServers(env.SEED_SERVERS);
  const result = await migrateAndSeed({
    databaseUrl: env.DATABASE_URL,
    kek: parseKek(env.KEK),
    adminEmail: env.ADMIN_EMAIL,
    adminPassword: env.ADMIN_PASSWORD,
    seedServers: servers,
  });
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'migrated',
      ...result,
      servers: servers.map((s) => s.slug),
    }),
  );
} catch (err) {
  // Only the message: a driver error object can carry the connection string.
  console.error(
    JSON.stringify({ level: 'error', msg: 'migrate failed', error: (err as Error).message }),
  );
  process.exit(1);
}
