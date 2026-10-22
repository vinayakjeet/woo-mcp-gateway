import { encryptSecret, evaluatePolicy, type PolicyRole, type PolicyRule } from '@woo/core';
import type { FastifyInstance } from 'fastify';
import type { ApiOptions } from './api.js';
import { loadRules } from './api-policies.js';
import { parseId, requireAdmin, requireUser, type SessionUser } from './api-session.js';
import { notify, withTx } from './db.js';
import { nextSecret, parseCreate, parsePatch } from './server-input.js';
import { urlCheck } from './ssrf.js';

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
  name: string;
  state: string;
  exposedName: string;
  title: string | null;
  description: string | null;
  readOnly: boolean;
};

// auth_secret_enc is never selected: only whether it is set leaves the database (the dashboard API design).
const SERVER_SELECT = `select s.id, s.slug, s.name, s.url, s.kind, s.managed, s.enabled, s.approval,
    s.protocol_mode as "protocolMode", s.timeout_ms as "timeoutMs", s.auth_type as "authType",
    s.auth_header_name as "authHeaderName", s.auth_secret_enc is not null as "hasSecret",
    st.state, st.tool_count as "toolCount", st.error_kind as "errorKind",
    st.error_message as "errorMessage", st.checked_at as "checkedAt", st.last_ok_at as "lastOkAt"
  from mcp_servers s left join mcp_server_status st on st.server_id = s.id`;
const TOOL_SELECT = `select server_id as "serverId", name, state, exposed_name as "exposedName", title, description,
    coalesce(annotations->'readOnlyHint' = 'true'::jsonb, false) as "readOnly"
  from mcp_tools where state <> 'removed'`;

const ROLES: PolicyRole[] = ['admin', 'member'];

function serverView(r: ServerRow, tools: ToolRow[], rules: PolicyRule[]) {
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
    // roles come from the same evaluator the gateway uses, so this column cannot disagree with
    // what a member's tools/list shows. readOnly is a hint from the upstream, never enforced.
    tools: tools.map(({ name, state, exposedName, title, description, readOnly }) => ({
      exposedName,
      title,
      description,
      readOnly,
      state,
      roles: ROLES.filter((role) => evaluatePolicy(rules, role, r.slug, name)),
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
  return serverView(row, t.rows, await loadRules(o.pool));
}

// seed.ts rewrites every other column of a managed server on each control-plane start, so edits
// to them would be lost silently.
const MANAGED_EDITABLE = new Set(['enabled', 'timeoutMs']);

export function serverRoutes(scope: FastifyInstance, o: ApiOptions): void {
  const checkUrl = o.checkUrl ?? urlCheck(false);

  scope.get('/api/servers', { preHandler: requireUser }, async () => {
    const s = await o.pool.query<ServerRow>(`${SERVER_SELECT} order by s.name`);
    const t = await o.pool.query<ToolRow>(`${TOOL_SELECT} order by exposed_name`);
    const byServer = new Map<string, ToolRow[]>();
    for (const tool of t.rows)
      byServer.set(tool.serverId, [...(byServer.get(tool.serverId) ?? []), tool]);
    const rules = await loadRules(o.pool);
    return { servers: s.rows.map((r) => serverView(r, byServer.get(r.id) ?? [], rules)) };
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
           auth_secret_enc, timeout_ms, protocol_mode, approval, created_by)
         values ($1, $2, $3, 'external', false, $4, $5, $6, $7, $8, 'pending', $9)
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

  scope.patch('/api/servers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId(req.params);
    if (!id) return reply.code(404).send({ error: 'not_found' });
    const p = parsePatch(req.body);
    if (!p.ok) return reply.code(400).send({ error: p.error });
    const v = p.value;
    if (v.url) {
      const problem = await checkUrl(v.url);
      if (problem) return reply.code(400).send({ error: 'url_rejected', reason: problem });
    }
    const secret = nextSecret(v.auth);
    const out = await withTx(o.pool, async (c) => {
      const cur = await c.query<{
        slug: string;
        kind: string;
        managed: boolean;
        hasSecret: boolean;
      }>(
        `select slug, kind, managed, auth_secret_enc is not null as "hasSecret"
         from mcp_servers where id = $1 for update`,
        [id],
      );
      const s = cur.rows[0];
      if (!s) return 'not_found' as const;
      // Only the reconcile pass enables a hosted server, once its Deployment is available. An
      // admin enabling it earlier would point the gateway at a pod that does not exist yet.
      if (s.kind === 'hosted' && v.enabled === true) {
        const h = await c.query<{ status: string }>(
          'select status from hosted_servers where server_id = $1',
          [id],
        );
        if (h.rows[0]?.status !== 'ready') return 'hosted_not_ready' as const;
      }
      if (s.managed && Object.keys(v).some((k) => !MANAGED_EDITABLE.has(k))) {
        return 'managed_server' as const;
      }
      // Bearer or header auth with nothing stored and nothing typed would send no credential.
      if (v.auth && v.auth.type !== 'none' && secret === undefined && !s.hasSecret) {
        return 'secret_required' as const;
      }
      await c.query(
        `update mcp_servers set
           name = coalesce($2, name),
           url = coalesce($3, url),
           approval = case when $3::text is not null and $3 <> url then 'pending'::approval else approval end,
           timeout_ms = coalesce($4, timeout_ms),
           protocol_mode = coalesce($5, protocol_mode),
           enabled = coalesce($6, enabled),
           auth_type = coalesce($7, auth_type),
           auth_header_name = case when $7::auth_type is null then auth_header_name else $8 end,
           auth_secret_enc = case when $9::boolean then $10 else auth_secret_enc end,
           updated_at = now()
         where id = $1`,
        [
          id,
          v.name ?? null,
          v.url ?? null,
          v.timeoutMs ?? null,
          v.protocolMode ?? null,
          v.enabled ?? null,
          v.auth?.type ?? null,
          v.auth?.type === 'header' ? v.auth.headerName : null,
          secret !== undefined,
          secret ? encryptSecret(secret, o.kek, s.slug) : null,
        ],
      );
      await notify(c, 'registry_changed', id);
      return 'ok' as const;
    });
    if (out === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (out === 'managed_server') return reply.code(409).send({ error: 'managed_server' });
    if (out === 'hosted_not_ready') return reply.code(409).send({ error: 'hosted_not_ready' });
    if (out === 'secret_required') return reply.code(400).send({ error: 'secret_required' });
    return { server: await getServer(o, id) };
  });

  scope.delete('/api/servers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId(req.params);
    if (!id) return reply.code(404).send({ error: 'not_found' });
    const out = await withTx(o.pool, async (c) => {
      const cur = await c.query<{ managed: boolean }>(
        'select managed from mcp_servers where id = $1 for update',
        [id],
      );
      const s = cur.rows[0];
      if (!s) return 'not_found' as const;
      // Managed servers come back from the seed on the next start; they are disabled instead.
      if (s.managed) return 'managed_server' as const;
      await c.query('delete from mcp_servers where id = $1', [id]);
      await notify(c, 'registry_changed', id);
      return 'ok' as const;
    });
    if (out === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (out === 'managed_server') return reply.code(409).send({ error: 'managed_server' });
    return reply.code(204).send();
  });
}
