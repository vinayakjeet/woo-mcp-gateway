import { randomBytes } from 'node:crypto';
import { parseApiKey, verifyApiKeySecret } from '@woo/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKey } from './keys.js';
import { migrateAndSeed } from './migrate-run.js';
import { freshDatabase } from './test-db.js';

const base = process.env.TEST_DATABASE_URL;
const pepper = 'test-pepper';

describe.skipIf(!base)('createKey (needs TEST_DATABASE_URL)', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    const url = await freshDatabase(base!, 'woo_keys_test');
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

  it('stores a hashed key for the admin and returns the clear key once', async () => {
    const { id, key } = await createKey(pool, {
      email: 'ADMIN@example.com',
      name: 'smoke',
      pepper,
    });
    expect(key).toMatch(/^urk_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    const parsed = parseApiKey(key)!;
    const { rows } = await pool.query(
      `select k.prefix, k.tool_mode, k.secret_hash, k.name, u.email, row_to_json(k)::text as raw
         from api_keys k join users u on u.id = k.user_id where k.id = $1`,
      [id],
    );
    const row = rows[0];
    expect(row.prefix).toBe(parsed.prefix);
    expect(row.email).toBe('admin@example.com');
    expect(row.tool_mode).toBe('auto');
    expect(row.name).toBe('smoke');
    expect(verifyApiKeySecret(parsed.secret, pepper, row.secret_hash)).toBe(true);
    expect(row.raw).not.toContain(parsed.secret);
  });

  it('rejects an unknown email', async () => {
    await expect(
      createKey(pool, { email: 'nobody@example.com', name: 'x', pepper }),
    ).rejects.toThrow('no active user with that email');
  });

  it('rejects a disabled user', async () => {
    await pool.query(
      `insert into users (email, name, role, status) values ('off@example.com', 'Off', 'member', 'disabled')`,
    );
    await expect(createKey(pool, { email: 'off@example.com', name: 'x', pepper })).rejects.toThrow(
      'no active user with that email',
    );
  });
});
