import pg from 'pg';

// One database per test file: vitest runs files in parallel and migrations are not isolated by schema.
export async function freshDatabase(baseUrl: string, name: string): Promise<string> {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  return u.toString();
}
