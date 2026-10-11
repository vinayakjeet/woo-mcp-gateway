import { migrationsFolder, schema } from '@woo/core/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { Db } from './types.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// One database per test file: vitest runs files in parallel and migrations are not isolated by schema.
export async function migratedDatabase(
  name: string,
): Promise<{ url: string; pool: pg.Pool; db: Db }> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${name}`;
  const url = u.toString();
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder });
  return { url, pool, db };
}
