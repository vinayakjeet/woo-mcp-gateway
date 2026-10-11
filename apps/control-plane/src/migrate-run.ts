import { errorCode } from '@woo/core';
import { SCHEMA_VERSION, migrationsFolder, schema } from '@woo/core/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { seedAdmin, seedServers, type SeedServer } from './seed.js';

export const MIGRATION_LOCK = 4241;

export type MigrateOptions = {
  databaseUrl: string;
  kek: Buffer;
  adminEmail: string;
  adminPassword: string;
  seedServers: SeedServer[];
  // A stuck migrator must not hold every new pod in its init container forever.
  lockTimeout?: string;
};

// Drizzle puts the failed SQL and its params in the error message, so only the step and the
// SQLSTATE (or errno name) leave this module.
export class MigrateStepError extends Error {
  constructor(
    readonly step: string,
    readonly code: string,
  ) {
    super(`${step} failed (code ${code})`);
  }
}

async function inStep<T>(step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new MigrateStepError(step, errorCode(err));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Postgres may still be starting when the initContainer runs.
async function connect(databaseUrl: string, timeoutMs = 60_000): Promise<pg.Client> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new pg.Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => undefined);
      if (Date.now() >= deadline) throw err;
      await sleep(2000);
    }
  }
}

export async function migrateAndSeed(
  o: MigrateOptions,
): Promise<{ schemaVersion: number; adminCreated: boolean }> {
  const client = await inStep('connect', () => connect(o.databaseUrl));
  // Without a listener a dropped connection is an uncaught exception. Only the message is logged.
  client.on('error', (err) => {
    console.error(
      JSON.stringify({ level: 'error', msg: 'database connection error', error: err.message }),
    );
  });
  try {
    await inStep('lock', async () => {
      await client.query("select set_config('lock_timeout', $1, false)", [o.lockTimeout ?? '120s']);
      await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    });
    const db = drizzle(client, { schema });
    await inStep('migrate', () => migrate(db, { migrationsFolder }));
    await inStep('seed-servers', () => seedServers(db, o.seedServers, o.kek));
    const adminCreated = await inStep('seed-admin', () =>
      seedAdmin(db, o.adminEmail, o.adminPassword),
    );
    await inStep('unlock', () => client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]));
    return { schemaVersion: SCHEMA_VERSION, adminCreated };
  } finally {
    // Closing the session also releases the advisory lock when a step above failed.
    await client.end().catch(() => undefined);
  }
}
