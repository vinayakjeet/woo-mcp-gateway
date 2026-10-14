import { policyRuleInput, sortRules, type PolicyRule } from '@woo/core';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { ApiOptions } from './api.js';
import { parseId, requireAdmin, requireUser } from './api-session.js';
import { notify, withTx } from './db.js';

// Serialises the duplicate check with the insert; no unique index exists because priority and
// the four fields together are the rule's identity.
const POLICY_WRITE_LOCK = 4244;

const COLUMNS = `id, role, server_pattern as "serverPattern", tool_pattern as "toolPattern",
  effect, priority, created_at as "createdAt"`;

export async function loadRules(pool: pg.Pool): Promise<PolicyRule[]> {
  const r = await pool.query<PolicyRule>(`select ${COLUMNS} from tool_policies`);
  return r.rows;
}

export function policyRoutes(scope: FastifyInstance, o: ApiOptions): void {
  // Members read the rules too: the Policies page is read-only for them.
  scope.get('/api/policies', { preHandler: requireUser }, async () => ({
    policies: sortRules(await loadRules(o.pool)),
  }));

  scope.post('/api/policies', { preHandler: requireAdmin }, async (req, reply) => {
    const body = policyRuleInput.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_policy' });
    const v = body.data;
    const created = await withTx(o.pool, async (c) => {
      await c.query('select pg_advisory_xact_lock($1)', [POLICY_WRITE_LOCK]);
      const dup = await c.query(
        `select 1 from tool_policies where role = $1 and server_pattern = $2
           and tool_pattern = $3 and effect = $4 and priority = $5`,
        [v.role, v.serverPattern, v.toolPattern, v.effect, v.priority],
      );
      if (dup.rowCount) return null;
      const r = await c.query<PolicyRule>(
        `insert into tool_policies (role, server_pattern, tool_pattern, effect, priority)
         values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
        [v.role, v.serverPattern, v.toolPattern, v.effect, v.priority],
      );
      const row = r.rows[0]!;
      await notify(c, 'policies_changed', row.id);
      return row;
    });
    if (!created) return reply.code(409).send({ error: 'policy_exists' });
    return reply.code(201).send({ policy: created });
  });

  scope.delete('/api/policies/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId(req.params);
    if (!id) return reply.code(404).send({ error: 'not_found' });
    const removed = await withTx(o.pool, async (c) => {
      const r = await c.query('delete from tool_policies where id = $1 returning id', [id]);
      if (r.rowCount === 0) return false;
      await notify(c, 'policies_changed', id);
      return true;
    });
    return removed ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });
}
