import type { Tool } from '@modelcontextprotocol/client';
import { decryptSecret, exposedToolName } from '@woo/core';
import { schema } from '@woo/core/db';
import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { canonicalJson, sha256Hex } from './canonical.js';
import type { Db, PersistedTool, ServerRecord, ToolState, UpstreamAuth } from './types.js';

export type LoadedServer = { record: ServerRecord; tools: PersistedTool[] };
type ServerRow = typeof schema.mcpServers.$inferSelect;

export function definitionHash(t: Tool): string {
  return sha256Hex(
    canonicalJson({
      name: t.name,
      description: t.description ?? null,
      inputSchema: t.inputSchema,
      annotations: t.annotations ?? null,
    }),
  );
}

// The slug is the AAD, so a ciphertext copied from another server's row fails here and the
// server is reported instead of connecting with somebody else's credential.
function credential(row: ServerRow, kek: Buffer): { auth: UpstreamAuth; credentialError?: true } {
  if (row.authType === 'none') return { auth: { type: 'none' } };
  try {
    if (!row.authSecretEnc) throw new Error('no stored secret');
    const secret = decryptSecret(row.authSecretEnc, kek, row.slug);
    if (row.authType === 'bearer') return { auth: { type: 'bearer', secret } };
    if (!row.authHeaderName) throw new Error('no header name');
    return { auth: { type: 'header', headerName: row.authHeaderName, secret } };
  } catch {
    return { auth: { type: 'none' }, credentialError: true };
  }
}

export async function loadServers(db: Db, kek: Buffer, id?: string): Promise<LoadedServer[]> {
  const s = schema.mcpServers;
  const t = schema.mcpTools;
  const rows = await db
    .select()
    .from(s)
    .where(id ? eq(s.id, id) : undefined);
  if (rows.length === 0) return [];
  const tools = await db
    .select({
      serverId: t.serverId,
      name: t.name,
      exposedName: t.exposedName,
      state: t.state,
      definitionHash: t.definitionHash,
    })
    .from(t)
    .where(
      inArray(
        t.serverId,
        rows.map((r) => r.id),
      ),
    );
  return rows.map((row) => {
    const { auth, credentialError } = credential(row, kek);
    const record: ServerRecord = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      url: row.url,
      kind: row.kind,
      enabled: row.enabled,
      approval: row.approval,
      timeoutMs: row.timeoutMs,
      protocolMode: row.protocolMode,
      auth,
      ...(credentialError ? { credentialError } : {}),
    };
    return {
      record,
      tools: tools
        .filter((x) => x.serverId === row.id)
        .map(({ name, exposedName, state, definitionHash }) => ({
          name,
          exposedName,
          state,
          definitionHash,
        })),
    };
  });
}

export async function upsertTools(
  db: Db,
  serverId: string,
  slug: string,
  tools: readonly Tool[],
): Promise<Map<string, ToolState>> {
  const t = schema.mcpTools;
  return db.transaction(async (tx) => {
    const now = new Date();
    const names = tools.map((x) => x.name);
    if (tools.length > 0) {
      await tx
        .insert(t)
        .values(
          tools.map((x) => ({
            serverId,
            name: x.name,
            exposedName: exposedToolName(slug, x.name),
            title: x.title ?? null,
            description: x.description ?? null,
            inputSchema: x.inputSchema,
            annotations: x.annotations ?? null,
            definitionHash: definitionHash(x),
            lastSeenAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [t.serverId, t.name],
          set: {
            exposedName: sql`excluded.exposed_name`,
            title: sql`excluded.title`,
            description: sql`excluded.description`,
            inputSchema: sql`excluded.input_schema`,
            annotations: sql`excluded.annotations`,
            definitionHash: sql`excluded.definition_hash`,
            lastSeenAt: sql`excluded.last_seen_at`,
            // A tool that comes back is active again; "changed" belongs to tool approval and stays.
            state: sql`case when "mcp_tools"."state" = 'removed' then 'active'::tool_state else "mcp_tools"."state" end`,
          },
        });
    }
    await tx
      .update(t)
      .set({ state: 'removed' })
      .where(
        and(
          eq(t.serverId, serverId),
          ne(t.state, 'removed'),
          names.length > 0 ? notInArray(t.name, names) : undefined,
        ),
      );
    const rows = await tx
      .select({ name: t.name, state: t.state })
      .from(t)
      .where(eq(t.serverId, serverId));
    return new Map(rows.map((r) => [r.name, r.state]));
  });
}
