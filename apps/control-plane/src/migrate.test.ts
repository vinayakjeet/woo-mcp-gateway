import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { decryptSecret } from '@woo/core';
import { SCHEMA_VERSION } from '@woo/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAndSeed } from './migrate-run.js';
import type { SeedServer } from './seed.js';
import { freshDatabase } from './test-db.js';

const base = process.env.TEST_DATABASE_URL;
let url: string;
const kek = randomBytes(32);

function servers(mainToken: string): SeedServer[] {
  return [
    {
      slug: 'main',
      name: 'Main Store',
      url: 'http://woo-mcp.store-main.svc.cluster.local:8080/mcp',
      kind: 'store',
      managed: true,
      auth: { type: 'bearer', secret: mainToken },
    },
    {
      slug: 'fx',
      name: 'Currency',
      url: 'http://fx-mcp.platform.svc.cluster.local:8080/mcp',
      kind: 'system',
      managed: true,
      auth: { type: 'bearer', secret: 'fx-token' },
    },
  ];
}
const opts = (mainToken: string, adminPassword: string) => ({
  databaseUrl: url,
  kek,
  adminEmail: 'admin@example.com',
  adminPassword,
  seedServers: servers(mainToken),
});

describe.skipIf(!base)('migrateAndSeed (needs TEST_DATABASE_URL)', () => {
  let client: pg.Client;
  beforeAll(async () => {
    url = await freshDatabase(base!, 'woo_migrate_test');
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  it('two concurrent runs leave one admin and no errors', async () => {
    await Promise.all([
      migrateAndSeed(opts('tok-1', 'pw-one')),
      migrateAndSeed(opts('tok-1', 'pw-one')),
    ]);
    const u = await client.query('select email::text, role, status, password_hash from users');
    expect(u.rows).toHaveLength(1);
    expect(u.rows[0]).toMatchObject({
      email: 'admin@example.com',
      role: 'admin',
      status: 'active',
    });
    expect(u.rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it('seeds main and fx with encrypted bearer secrets', async () => {
    const r = await client.query(
      'select slug, kind, auth_type, auth_secret_enc from mcp_servers order by slug',
    );
    expect(r.rows.map((x) => [x.slug, x.kind, x.auth_type])).toEqual([
      ['fx', 'system', 'bearer'],
      ['main', 'store', 'bearer'],
    ]);
    expect(decryptSecret(r.rows[1].auth_secret_enc, kek)).toBe('tok-1');
  });

  it('reseeding updates the token, keeps enabled and the existing admin', async () => {
    const before = await client.query('select password_hash from users');
    await client.query("update mcp_servers set enabled = false where slug = 'fx'");
    await migrateAndSeed(opts('tok-2', 'pw-two'));
    const main = await client.query("select auth_secret_enc from mcp_servers where slug = 'main'");
    expect(decryptSecret(main.rows[0].auth_secret_enc, kek)).toBe('tok-2');
    const fx = await client.query("select enabled from mcp_servers where slug = 'fx'");
    expect(fx.rows[0].enabled).toBe(false);
    const after = await client.query('select password_hash from users');
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].password_hash).toBe(before.rows[0].password_hash);
  });

  it('records every migration', async () => {
    const r = await client.query('select count(*)::int as n from drizzle.__drizzle_migrations');
    expect(r.rows[0].n).toBe(SCHEMA_VERSION);
  });
});
