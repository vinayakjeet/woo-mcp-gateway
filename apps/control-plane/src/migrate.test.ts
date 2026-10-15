import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { decryptSecret, encryptSecret } from '@woo/core';
import { SCHEMA_VERSION, migrationsFolder } from '@woo/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_LOCK, MigrateStepError, migrateAndSeed } from './migrate-run.js';
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
      protocolMode: 'auto',
      auth: { type: 'bearer', secret: mainToken },
    },
    {
      slug: 'fx',
      name: 'Currency',
      url: 'http://fx-mcp.platform.svc.cluster.local:8080/mcp',
      kind: 'system',
      managed: true,
      protocolMode: 'auto',
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
    expect(decryptSecret(r.rows[1].auth_secret_enc, kek, 'main')).toBe('tok-1');
  });

  it('seeds main and fx with protocol_mode auto and reseeding rewrites it', async () => {
    const modes = async () =>
      (await client.query('select slug, protocol_mode from mcp_servers order by slug')).rows.map(
        (x) => [x.slug, x.protocol_mode],
      );
    expect(await modes()).toEqual([
      ['fx', 'auto'],
      ['main', 'auto'],
    ]);
    await client.query("update mcp_servers set protocol_mode = 'legacy'");
    await migrateAndSeed(opts('tok-1', 'pw-one'));
    expect(await modes()).toEqual([
      ['fx', 'auto'],
      ['main', 'auto'],
    ]);
  });

  it('reseeding updates the token, keeps enabled and the existing admin', async () => {
    const before = await client.query('select password_hash from users');
    await client.query("update mcp_servers set enabled = false where slug = 'fx'");
    await migrateAndSeed(opts('tok-2', 'pw-two'));
    const main = await client.query("select auth_secret_enc from mcp_servers where slug = 'main'");
    expect(decryptSecret(main.rows[0].auth_secret_enc, kek, 'main')).toBe('tok-2');
    const fx = await client.query("select enabled from mcp_servers where slug = 'fx'");
    expect(fx.rows[0].enabled).toBe(false);
    const after = await client.query('select password_hash from users');
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].password_hash).toBe(before.rows[0].password_hash);
  });

  it('binds each secret to its slug', async () => {
    const r = await client.query("select auth_secret_enc from mcp_servers where slug = 'main'");
    expect(() => decryptSecret(r.rows[0].auth_secret_enc, kek, 'fx')).toThrow();
  });

  it('reseeding re-encrypts a row stored without the slug as aad', async () => {
    await client.query("update mcp_servers set auth_secret_enc = $1 where slug = 'main'", [
      encryptSecret('tok-2', kek, ''),
    ]);
    await migrateAndSeed(opts('tok-2', 'pw-two'));
    const r = await client.query("select auth_secret_enc from mcp_servers where slug = 'main'");
    expect(decryptSecret(r.rows[0].auth_secret_enc, kek, 'main')).toBe('tok-2');
  });

  it('records every migration', async () => {
    const r = await client.query('select count(*)::int as n from drizzle.__drizzle_migrations');
    expect(r.rows[0].n).toBe(SCHEMA_VERSION);
  });
});

describe.skipIf(!base)('migration 0002 (needs TEST_DATABASE_URL)', () => {
  let dir: string;
  let client: pg.Client;
  beforeAll(async () => {
    const dbUrl = await freshDatabase(base!, 'woo_migrate_0002_test');
    client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    // The same folder with a journal cut after 0001, so the test can insert rows before 0002 runs.
    dir = mkdtempSync(join(tmpdir(), 'woo-migrations-'));
    cpSync(migrationsFolder, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((e) => e.tag < '0002');
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
    await migrate(drizzle(client), { migrationsFolder: dir });
  }, 30_000);
  afterAll(async () => {
    await client.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it('0002 backfills tools_synced_at for servers with tool rows and leaves the others null', async () => {
    await client.query(`insert into mcp_servers (slug, name, url, kind) values
      ('withtools', 'W', 'http://w.test/mcp', 'hosted'),
      ('removedonly', 'R', 'http://r.test/mcp', 'hosted'),
      ('empty', 'E', 'http://e.test/mcp', 'hosted')`);
    await client.query(`insert into mcp_tools (server_id, name, exposed_name, input_schema, definition_hash, state)
      select id, 't', slug || '__t', '{}', 'h', case when slug = 'removedonly' then 'removed' else 'active' end::tool_state
      from mcp_servers where slug in ('withtools', 'removedonly')`);
    await migrate(drizzle(client), { migrationsFolder });
    const r = await client.query(
      'select slug, tools_synced_at is not null as synced from mcp_servers order by slug',
    );
    expect(r.rows).toEqual([
      { slug: 'empty', synced: false },
      { slug: 'removedonly', synced: true },
      { slug: 'withtools', synced: true },
    ]);
  });
});

describe.skipIf(!base)('migrateAndSeed failures (needs TEST_DATABASE_URL)', () => {
  const db = { fail: '', lock: '', kill: '' };
  // CREATE DATABASE competes with every other test file doing the same. Under full-suite load it
  // took up to 4 s, which left too little of a test's 5 s for the migration run under test.
  beforeAll(async () => {
    for (const k of ['fail', 'lock', 'kill'] as const)
      db[k] = await freshDatabase(base!, `woo_migrate_${k}_test`);
  }, 30_000);
  it('reports the step and the SQLSTATE, never the query params', async () => {
    url = db.fail;
    const bad = servers('tok-1');
    // A NUL byte is rejected by Postgres, so the failing insert carries LEAKMARKER in its params.
    bad[0]!.name = 'LEAKMARKER\u0000';
    const err = await migrateAndSeed({ ...opts('tok-1', 'pw'), seedServers: bad }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MigrateStepError);
    expect(err).toMatchObject({ step: 'seed-servers', code: '22021' });
    expect(String((err as Error).message)).not.toContain('LEAKMARKER');
    expect((err as Error).message).toBe('seed-servers failed (code 22021)');
  });

  it('times out waiting for the lock, closes its connection and works again once the lock is free', async () => {
    url = db.lock;
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    await holder.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    try {
      const err = await migrateAndSeed({ ...opts('tok-1', 'pw'), lockTimeout: '300ms' }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ step: 'lock', code: '55P03' });
      const waiting = await holder.query(
        'select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()',
      );
      expect(waiting.rows[0].n).toBe(0);
    } finally {
      await holder.end();
    }
    await expect(migrateAndSeed(opts('tok-1', 'pw'))).resolves.toMatchObject({
      adminCreated: true,
    });
  });

  it('survives the connection being killed while it waits for the lock', async () => {
    url = db.kill;
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    await holder.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    try {
      const run = migrateAndSeed({ ...opts('tok-1', 'pw'), lockTimeout: '10s' }).catch(
        (e: unknown) => e,
      );
      await new Promise((r) => setTimeout(r, 500));
      await holder.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and query like '%pg_advisory_lock%'",
      );
      expect(await run).toMatchObject({ step: 'lock' });
    } finally {
      await holder.end();
    }
  });
});
