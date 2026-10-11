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
};

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
  const client = await connect(o.databaseUrl);
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
    await seedServers(db, o.seedServers, o.kek);
    const adminCreated = await seedAdmin(db, o.adminEmail, o.adminPassword);
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    return { schemaVersion: SCHEMA_VERSION, adminCreated };
  } finally {
    await client.end();
  }
}
