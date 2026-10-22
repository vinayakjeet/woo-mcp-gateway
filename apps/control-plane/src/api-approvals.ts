import { screenTool } from '@woo/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiOptions } from './api.js';
import { parseId, requireAdmin } from './api-session.js';
import { notify, withTx } from './db.js';

// The hashes the admin was shown, keyed by the upstream tool name.
const approveInput = z
  .object({
    tools: z.record(z.string().min(1).max(128), z.string().regex(/^[0-9a-f]{64}$/)).default({}),
  })
  .strict();

type ApprovalRow = {
  serverId: string;
  slug: string;
  name: string;
  url: string;
  kind: string;
  approval: string;
};
type ToolRow = {
  serverId: string;
  name: string;
  exposedName: string;
  state: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
  annotations: unknown;
  definitionHash: string;
  approvedHash: string | null;
  approvedDefinition: unknown;
};

export function approvalRoutes(scope: FastifyInstance, o: ApiOptions): void {
  // No auth column is selected here: an upstream credential never leaves the database.
  scope.get('/api/approvals', { preHandler: requireAdmin }, async () => {
    const s = await o.pool.query<ApprovalRow>(
      `select s.id as "serverId", s.slug, s.name, s.url, s.kind, s.approval
       from mcp_servers s
       where s.kind in ('external', 'hosted') and (s.approval = 'pending'
         or exists (select 1 from mcp_tools t where t.server_id = s.id and t.state = 'changed'))
       order by s.name`,
    );
    const ids = s.rows.map((r) => r.serverId);
    const t = await o.pool.query<ToolRow>(
      `select t.server_id as "serverId", t.name, t.exposed_name as "exposedName", t.state, t.title,
         t.description, t.input_schema as "inputSchema", t.annotations,
         t.definition_hash as "definitionHash", t.approved_hash as "approvedHash",
         t.approved_definition as "approvedDefinition"
       from mcp_tools t join mcp_servers s on s.id = t.server_id
       where t.server_id = any($1::uuid[]) and t.state <> 'removed'
         and (s.approval = 'pending' or t.state = 'changed')
       order by t.exposed_name`,
      [ids],
    );
    return {
      servers: s.rows.map(({ serverId, ...r }) => ({
        id: serverId,
        ...r,
        tools: t.rows
          .filter((x) => x.serverId === serverId)
          .map((x) => ({
            name: x.name,
            exposedName: x.exposedName,
            state: x.state,
            title: x.title,
            definitionHash: x.definitionHash,
            approvedHash: x.approvedHash,
            current: {
              description: x.description,
              inputSchema: x.inputSchema,
              annotations: x.annotations,
            },
            approved: x.approvedDefinition ?? null,
            flags: screenTool(x),
          })),
      })),
    };
  });

  scope.post('/api/servers/:id/approve', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId(req.params);
    if (!id) return reply.code(404).send({ error: 'not_found' });
    const body = approveInput.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const wanted = Object.entries(body.data.tools);
    const out = await withTx(o.pool, async (c) => {
      const cur = await c.query<{ managed: boolean; kind: string }>(
        'select managed, kind from mcp_servers where id = $1 for update',
        [id],
      );
      const s = cur.rows[0];
      if (!s) return 'not_found' as const;
      // Store and system servers are approved as they are (the tool pinning rules). A hosted server is approved
      // on its first sync only, so a later change goes through here like an external one.
      if (s.kind !== 'external' && s.kind !== 'hosted') return 'auto_approved' as const;
      await c.query(
        "update mcp_servers set approval = 'approved', updated_at = now() where id = $1",
        [id],
      );
      // A tool whose definition moved since the admin looked keeps its hash mismatch and stays hidden.
      const done = await c.query<{ name: string }>(
        `update mcp_tools t set
           approved_hash = t.definition_hash,
           approved_definition = jsonb_build_object('name', t.name, 'description', t.description,
             'inputSchema', t.input_schema, 'annotations', t.annotations),
           state = 'active'
         from unnest($2::text[], $3::text[]) as x(name, hash)
         where t.server_id = $1 and t.name = x.name and t.definition_hash = x.hash
           and t.state <> 'removed'
         returning t.name`,
        [id, wanted.map(([n]) => n), wanted.map(([, h]) => h)],
      );
      await notify(c, 'registry_changed', id);
      const approved = done.rows.map((r) => r.name).sort();
      return {
        approved,
        stale: wanted
          .map(([n]) => n)
          .filter((n) => !approved.includes(n))
          .sort(),
      };
    });
    if (out === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (out === 'auto_approved') return reply.code(409).send({ error: 'auto_approved' });
    return out;
  });
}
