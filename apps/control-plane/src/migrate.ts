import { parseKek } from '@woo/core';
import { requireEnv } from './env.js';
import { MigrateStepError, migrateAndSeed } from './migrate-run.js';
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
  // A step error carries only a step name and a code. Anything else is one of our own
  // validation messages (env, KEK, seed JSON), which never include values.
  const detail =
    err instanceof MigrateStepError
      ? { step: err.step, code: err.code }
      : { error: (err as Error).message };
  console.error(JSON.stringify({ level: 'error', msg: 'migrate failed', ...detail }));
  process.exit(1);
}
