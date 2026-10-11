import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAndSeed } from './migrate-run.js';
import { pgDeps } from './repo.js';
import { freshDatabase } from './test-db.js';

const base = process.env.TEST_DATABASE_URL;

describe.skipIf(!base)('pgDeps (needs TEST_DATABASE_URL)', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    const url = await freshDatabase(base!, 'woo_repo_test');
    await migrateAndSeed({
      databaseUrl: url,
      kek: randomBytes(32),
      adminEmail: 'admin@example.com',
      adminPassword: 'pw',
      seedServers: [],
    });
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('finds a user case-insensitively', async () => {
    const u = await pgDeps(pool).findUserByEmail('ADMIN@Example.com');
    expect(u).toMatchObject({ email: 'admin@example.com', role: 'admin', status: 'active' });
    expect(await pgDeps(pool).findUserByEmail('nobody@example.com')).toBeNull();
  });
  it('creates a session row and answers ping', async () => {
    const deps = pgDeps(pool);
    const u = (await deps.findUserByEmail('admin@example.com'))!;
    await deps.createSession({
      userId: u.id,
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 1000),
      userAgent: 'vitest',
    });
    const r = await pool.query('select user_agent from sessions where token_hash = $1', [
      'a'.repeat(64),
    ]);
    expect(r.rows[0].user_agent).toBe('vitest');
    expect(await deps.ping()).toBe(true);
  });
});
