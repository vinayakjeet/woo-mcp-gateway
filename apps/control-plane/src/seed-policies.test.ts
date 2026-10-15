import { cpSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEED_POLICIES } from '@woo/core';
import { migrationsFolder, schema } from '@woo/core/db';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedPolicies } from './seed.js';
import { freshDatabase } from './test-db.js';

const base = process.env.TEST_DATABASE_URL;

describe.skipIf(!base)('seedPolicies (needs TEST_DATABASE_URL)', () => {
  let client: pg.Client;
  let dbUrl: string;
  let db: NodePgDatabase<typeof schema>;
  beforeAll(async () => {
    dbUrl = await freshDatabase(base!, 'woo_seed_policies_test');
    client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
  });
  afterAll(async () => {
    await client.end();
  });

  const rows = async () =>
    (await client.query('select id from tool_policies order by id')).rows.length;

  it('sends NOTIFY policies_changed when it inserts, and not on a rerun', async () => {
    const l = new pg.Client({ connectionString: dbUrl });
    await l.connect();
    const got: string[] = [];
    l.on('notification', (n) => got.push(n.payload ?? ''));
    await l.query('LISTEN policies_changed');
    try {
      await seedPolicies(db);
      await vi.waitFor(() => expect(got).toHaveLength(1));
      await seedPolicies(db);
      await new Promise((r) => setTimeout(r, 100));
      expect(got).toHaveLength(1);
    } finally {
      await l.end();
    }
    await client.query('delete from tool_policies');
    await client.query("delete from platform_settings where key = 'policies_seeded'");
  });

  it('inserts the SPEC 8 rules once', async () => {
    await seedPolicies(db);
    expect(await rows()).toBe(SEED_POLICIES.length);
    await seedPolicies(db);
    expect(await rows()).toBe(SEED_POLICIES.length);
    const r = await client.query(
      "select count(*)::int as n from tool_policies where role = 'admin' and server_pattern = '*' and tool_pattern = '*' and effect = 'allow'",
    );
    expect(r.rows[0].n).toBe(1);
  });

  it('does nothing after an admin deleted a seeded rule', async () => {
    await client.query(
      "delete from tool_policies where server_pattern = 'gh' and tool_pattern = 'search_*'",
    );
    await seedPolicies(db);
    expect(await rows()).toBe(SEED_POLICIES.length - 1);
  });

  it('does nothing when the flag exists but the table is empty', async () => {
    await client.query('delete from tool_policies');
    await seedPolicies(db);
    expect(await rows()).toBe(0);
  });
});

describe.skipIf(!base)('migration 0001 (needs TEST_DATABASE_URL)', () => {
  let client: pg.Client;
  beforeAll(async () => {
    const url = await freshDatabase(base!, 'woo_migration_0001_test');
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  it('approves active tools of approved servers and nothing else', async () => {
    // A journal that stops at 0000 puts the database where an upgrade finds it.
    const old = mkdtempSync(join(tmpdir(), 'woo-mig-'));
    cpSync(migrationsFolder, old, { recursive: true });
    const journalPath = join(old, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
    journal.entries = journal.entries.slice(0, 1);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: old });

    await client.query(`
      insert into mcp_servers (id, slug, name, url, kind, approval) values
        ('00000000-0000-4000-8000-000000000001', 'ok', 'Ok', 'http://a', 'external', 'approved'),
        ('00000000-0000-4000-8000-000000000002', 'wait', 'Wait', 'http://b', 'external', 'pending')`);
    await client.query(`
      insert into mcp_tools (server_id, name, exposed_name, description, input_schema, annotations, definition_hash, state) values
        ('00000000-0000-4000-8000-000000000001', 'active_tool', 'ok__active_tool', 'does it', '{"type":"object"}', null, 'h1', 'active'),
        ('00000000-0000-4000-8000-000000000001', 'changed_tool', 'ok__changed_tool', 'x', '{}', null, 'h2', 'changed'),
        ('00000000-0000-4000-8000-000000000001', 'gone_tool', 'ok__gone_tool', 'x', '{}', null, 'h3', 'removed'),
        ('00000000-0000-4000-8000-000000000002', 'pending_tool', 'wait__pending_tool', 'x', '{}', null, 'h4', 'active')`);

    await migrate(db, { migrationsFolder });

    const r = await client.query(
      'select name, approved_hash, approved_definition from mcp_tools order by name',
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.name, x]));
    expect(by.active_tool.approved_hash).toBe('h1');
    expect(by.active_tool.approved_definition).toEqual({
      name: 'active_tool',
      description: 'does it',
      inputSchema: { type: 'object' },
      annotations: null,
    });
    expect(by.changed_tool.approved_hash).toBeNull();
    expect(by.gone_tool.approved_hash).toBeNull();
    expect(by.pending_tool.approved_hash).toBeNull();
    expect(by.pending_tool.approved_definition).toBeNull();
  });
});
