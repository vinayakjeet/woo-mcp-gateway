import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export { schema };
export * from './schema.js';

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8')) as {
  entries: unknown[];
};
export const SCHEMA_VERSION = journal.entries.length;

export async function schemaReady(db: {
  query(sql: string): Promise<{ rows: Array<{ n: number }> }>;
}): Promise<boolean> {
  try {
    const r = await db.query('select count(*)::int as n from drizzle.__drizzle_migrations');
    return (r.rows[0]?.n ?? 0) >= SCHEMA_VERSION;
  } catch {
    return false;
  }
}
