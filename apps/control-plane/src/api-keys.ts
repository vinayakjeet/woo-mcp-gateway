import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ApiOptions } from './api.js';
import { parseId, requireAdmin, requireUser, type SessionUser } from './api-session.js';
import { notify, withTx } from './db.js';
import { insertKey } from './keys.js';

const nameBody = z.object({ name: z.string().trim().min(1).max(100) });
const KEY_COLUMNS = `id, name, prefix, created_at as "createdAt", last_used_at as "lastUsedAt",
  revoked_at as "revokedAt", expires_at as "expiresAt"`;

async function listKeys(o: ApiOptions, userId: string) {
  const r = await o.pool.query(
    `select ${KEY_COLUMNS} from api_keys where user_id = $1 order by created_at desc`,
    [userId],
  );
  return { keys: r.rows };
}

async function issueKey(o: ApiOptions, userId: string, name: string, reply: FastifyReply) {
  const k = await insertKey(o.pool, { userId, name, pepper: o.pepper });
  const r = await o.pool.query(`select ${KEY_COLUMNS} from api_keys where id = $1`, [k.id]);
  // The only response that carries the full key; the database keeps an HMAC of its secret.
  return reply.code(201).send({ key: r.rows[0], secret: k.key });
}

export function keyRoutes(scope: FastifyInstance, o: ApiOptions): void {
  scope.get('/api/keys', { preHandler: requireUser }, async (req) =>
    listKeys(o, (req.user as SessionUser).id),
  );

  scope.post('/api/keys', { preHandler: requireUser }, async (req, reply) => {
    const body = nameBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    return issueKey(o, (req.user as SessionUser).id, body.data.name, reply);
  });

  scope.delete('/api/keys/:id', { preHandler: requireUser }, async (req, reply) => {
    const id = parseId(req.params);
    if (!id) return reply.code(404).send({ error: 'not_found' });
    const user = req.user as SessionUser;
    // Admins revoke any key (SPEC 7). A member asking for someone else's key gets the same 404
    // as for a missing one.
    const owner = user.role === 'admin' ? null : user.id;
    const revoked = await withTx(o.pool, async (c) => {
      const r = await c.query(
        `update api_keys set revoked_at = coalesce(revoked_at, now())
         where id = $1 and ($2::uuid is null or user_id = $2) returning id`,
        [id, owner],
      );
      if (r.rowCount === 0) return false;
      await notify(c, 'key_revoked', id);
      return true;
    });
    return revoked ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });

  scope.get('/api/users/:id/keys', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId(req.params);
    const found = id ? (await o.pool.query('select 1 from users where id = $1', [id])).rowCount : 0;
    if (!id || !found) return reply.code(404).send({ error: 'not_found' });
    return listKeys(o, id);
  });

  scope.post('/api/users/:id/keys', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId(req.params);
    if (!id) return reply.code(404).send({ error: 'not_found' });
    const body = nameBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const u = await o.pool.query<{ status: string }>('select status from users where id = $1', [
      id,
    ]);
    const status = u.rows[0]?.status;
    if (!status) return reply.code(404).send({ error: 'not_found' });
    // The key belongs to the member, and the gateway refuses keys of users who are not active.
    if (status !== 'active') return reply.code(409).send({ error: 'user_not_active' });
    return issueKey(o, id, body.data.name, reply);
  });
}
