import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiOptions } from './api.js';
import { parseId, requireAdmin, type SessionUser } from './api-session.js';
import { notify, withTx } from './db.js';

const patchBody = z
  .object({
    role: z.enum(['admin', 'member']).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict()
  .refine((b) => b.role !== undefined || b.status !== undefined);

const USER_COLUMNS = `id, email, name, role, status, created_at as "createdAt"`;

export function userRoutes(scope: FastifyInstance, o: ApiOptions): void {
  scope.get('/api/users', { preHandler: requireAdmin }, async () => {
    const r = await o.pool.query(
      `select ${USER_COLUMNS},
         (select count(*)::int from api_keys k
          where k.user_id = users.id and k.revoked_at is null) as "activeKeys"
       from users order by email`,
    );
    return { users: r.rows };
  });

  scope.patch('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId(req.params);
    if (!id) return reply.code(404).send({ error: 'not_found' });
    const body = patchBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    // Changing your own role or status could leave the platform without an admin.
    if (id === (req.user as SessionUser).id) {
      return reply.code(409).send({ error: 'cannot_change_self' });
    }
    const out = await withTx(o.pool, async (c) => {
      const cur = await c.query<{ status: string; hasPassword: boolean }>(
        `select status, password_hash is not null as "hasPassword" from users where id = $1 for update`,
        [id],
      );
      const u = cur.rows[0];
      if (!u) return 'not_found' as const;
      // Only accepting an invite activates an account, because that is where the password is set.
      if (body.data.status === 'active' && (u.status === 'invited' || !u.hasPassword)) {
        return 'invite_pending' as const;
      }
      const r = await c.query(
        `update users set role = coalesce($2, role), status = coalesce($3, status)
         where id = $1 returning ${USER_COLUMNS}`,
        [id, body.data.role ?? null, body.data.status ?? null],
      );
      if (body.data.status === 'disabled') {
        await c.query('delete from sessions where user_id = $1', [id]);
      }
      // The gateway caches each key with its user's role and status for 10 s; key_revoked drops
      // the cached entry now. The keys stay valid.
      const keys = await c.query<{ id: string }>(
        'select id from api_keys where user_id = $1 and revoked_at is null',
        [id],
      );
      for (const k of keys.rows) await notify(c, 'key_revoked', k.id);
      return r.rows[0];
    });
    if (out === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (out === 'invite_pending') return reply.code(409).send({ error: 'invite_pending' });
    return { user: out };
  });
}
