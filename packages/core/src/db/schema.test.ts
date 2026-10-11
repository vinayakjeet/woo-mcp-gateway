import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { migrationsFolder, schema, SCHEMA_VERSION, schemaReady } from './index.js';

const tables = [
  'users',
  'invites',
  'sessions',
  'api_keys',
  'mcp_servers',
  'mcp_server_status',
  'mcp_tools',
  'tool_policies',
  'audit_events',
  'stores',
  'hosted_servers',
  'rate_counters',
  'oauth_clients',
  'oauth_codes',
  'oauth_consents',
  'oauth_refresh_tokens',
  'platform_settings',
];

describe('schema', () => {
  it('defines every SPEC 4 table', () => {
    const names = Object.values(schema)
      .filter((t) => is(t, PgTable))
      .map((t) => getTableConfig(t as PgTable).name);
    expect(names.sort()).toEqual([...tables].sort());
  });
  it('first migration creates citext and every table', () => {
    const file = readdirSync(migrationsFolder).find((f) => f.startsWith('0000_'))!;
    const sql = readFileSync(join(migrationsFolder, file), 'utf8');
    expect(sql.indexOf('CREATE EXTENSION IF NOT EXISTS citext')).toBe(0);
    for (const t of tables) expect(sql).toContain(`CREATE TABLE "${t}"`);
    expect(sql).toContain('"email" "citext"');
  });
  it('api key prefix is unique char(8) and tool_mode defaults to auto', () => {
    const cfg = getTableConfig(schema.apiKeys);
    const prefix = cfg.columns.find((c) => c.name === 'prefix')!;
    expect(prefix.isUnique).toBe(true);
    expect(prefix.getSQLType()).toBe('char(8)');
    expect(cfg.columns.find((c) => c.name === 'tool_mode')!.default).toBe('auto');
  });
  it('schemaReady compares applied migrations with SCHEMA_VERSION', async () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(await schemaReady({ query: async () => ({ rows: [{ n: SCHEMA_VERSION }] }) })).toBe(
      true,
    );
    expect(await schemaReady({ query: async () => ({ rows: [{ n: SCHEMA_VERSION - 1 }] }) })).toBe(
      false,
    );
    expect(
      await schemaReady({
        query: async () => {
          throw new Error('relation does not exist');
        },
      }),
    ).toBe(false);
  });
});
