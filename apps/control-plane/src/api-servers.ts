import { encryptSecret } from '@woo/core';
import type { FastifyInstance } from 'fastify';
import type { ApiOptions } from './api.js';
import { requireAdmin, requireUser, type SessionUser } from './api-session.js';
import { notify, withTx } from './db.js';
import { parseCreate } from './server-input.js';
import { checkUpstreamUrl } from './ssrf.js';

type ServerRow = {
  id: string;
  slug: string;
  name: string;
  url: string;
  kind: string;
  managed: boolean;
  enabled: boolean;
  approval: string;
  protocolMode: string;
  timeoutMs: number;
  authType: 'none' | 'bearer' | 'header';
  authHeaderName: string | null;
  hasSecret: boolean;
  state: string | null;
  toolCount: number | null;
  errorKind: string | null;
  errorMessage: string | null;
  checkedAt: Date | null;
  lastOkAt: Date | null;
};
type ToolRow = {
  serverId: string;
  exposedName: string;
  title: string | null;
  description: string | null;
  readOnly: boolean;
};

// auth_secret_enc is never selected: only whether it is set leaves the database (SPEC 14).
const SERVER_SELECT = `select s.id, s.slug, s.name, s.url, s.kind, s.managed, s.enabled, s.approval,
    s.protocol_mode as "protocolMode", s.timeout_ms as "timeoutMs", s.auth_type as "authType",
    s.auth_header_name as "authHeaderName", s.auth_secret_enc is not null as "hasSecret",
    st.state, st.tool_count as "toolCount", st.error_kind as "errorKind",
    st.error_message as "errorMessage", st.checked_at as "checkedAt", st.last_ok_at as "lastOkAt"
  from mcp_servers s left join mcp_server_status st on st.server_id = s.id`;
const TOOL_SELECT = `select server_id as "serverId", exposed_name as "exposedName", title, description,
    coalesce(annotations->'readOnlyHint' = 'true'::jsonb, false) as "readOnly"
  from mcp_tools where state <> 'removed'`;

function serverView(r: ServerRow, tools: ToolRow[]) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    url: r.url,
    kind: r.kind,
    managed: r.managed,
    enabled: r.enabled,
    approval: r.approval,
    protocolMode: r.protocolMode,
    timeoutMs: r.timeoutMs,
    auth: { type: r.authType, headerName: r.authHeaderName, hasSecret: r.hasSecret },
    status:
      r.state === null
        ? null
        : {
            state: r.state,
            toolCount: r.toolCount,
            errorKind: r.errorKind,
            errorMessage: r.errorMessage,
            checkedAt: r.checkedAt,
            lastOkAt: r.lastOkAt,
          },
    tools: tools.map(({ exposedName, title, description, readOnly }) => ({
      exposedName,
      title,
      description,
      readOnly,
    })),
  };
}

export async function getServer(o: ApiOptions, id: string) {
  const s = await o.pool.query<ServerRow>(`${SERVER_SELECT} where s.id = $1`, [id]);
  const row = s.rows[0];
  if (!row) return null;
  const t = await o.pool.query<ToolRow>(`${TOOL_SELECT} and server_id = $1 order by exposed_name`, [
    id,
  ]);
  return serverView(row, t.rows);
}

export function serverRoutes(scope: FastifyInstance, o: ApiOptions): void {
  const checkUrl = o.checkUrl ?? checkUpstreamUrl;

  scope.get('/api/servers', { preHandler: requireUser }, async () => {
    const s = await o.pool.query<ServerRow>(`${SERVER_SELECT} order by s.name`);
    const t = await o.pool.query<ToolRow>(`${TOOL_SELECT} order by exposed_name`);
    const byServer = new Map<string, ToolRow[]>();
    for (const tool of t.rows)
      byServer.set(tool.serverId, [...(byServer.get(tool.serverId) ?? []), tool]);
    return { servers: s.rows.map((r) => serverView(r, byServer.get(r.id) ?? [])) };
  });

  scope.post('/api/servers', { preHandler: requireAdmin }, async (req, reply) => {
    const p = parseCreate(req.body);
    if (!p.ok) return reply.code(400).send({ error: p.error });
    const v = p.value;
    const problem = await checkUrl(v.url);
    if (problem) return reply.code(400).send({ error: 'url_rejected', reason: problem });
    // The slug is the AAD, so a ciphertext copied to another row fails to decrypt (core crypto.ts).
    const secretEnc = v.auth.type === 'none' ? null : encryptSecret(v.auth.secret!, o.kek, v.slug);
    const id = await withTx(o.pool, async (c) => {
      const r = await c.query<{ id: string }>(
        `insert into mcp_servers (slug, name, url, kind, managed, auth_type, auth_header_name,
           auth_secret_enc, timeout_ms, protocol_mode, created_by)
         values ($1, $2, $3, 'external', false, $4, $5, $6, $7, $8, $9)
         on conflict (slug) do nothing returning id`,
        [
          v.slug,
          v.name,
          v.url,
          v.auth.type,
          v.auth.type === 'header' ? v.auth.headerName : null,
          secretEnc,
          v.timeoutMs,
          v.protocolMode,
          (req.user as SessionUser).id,
        ],
      );
      const row = r.rows[0];
      if (row) await notify(c, 'registry_changed', row.id);
      return row?.id ?? null;
    });
    if (!id) return reply.code(409).send({ error: 'slug_taken' });
    return reply.code(201).send({ server: await getServer(o, id) });
  });
}
