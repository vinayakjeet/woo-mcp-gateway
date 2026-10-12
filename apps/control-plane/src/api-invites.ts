import { hash } from '@node-rs/argon2';
import { generateSessionToken, hashToken, sessionCookie, sessionExpiresAt } from '@woo/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiOptions } from './api.js';
import { requireAdmin, type SessionUser } from './api-session.js';
import { withTx } from './db.js';

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const VALID = `token_hash = $1 and accepted_at is null and expires_at > now()`;

const createBody = z.object({
  email: z.string().email().max(320),
  role: z.enum(['admin', 'member']),
});
const acceptBody = z.object({
  password: z.string().min(12).max(1024),
  name: z.string().trim().min(1).max(100).optional(),
});

type Invite = { email: string; role: 'admin' | 'member' };

async function findInvite(o: ApiOptions, token: string): Promise<Invite | null> {
  if (!TOKEN_RE.test(token)) return null;
  const r = await o.pool.query<Invite>(`select email, role from invites where ${VALID}`, [
    hashToken(token),
  ]);
  return r.rows[0] ?? null;
}

export function inviteRoutes(scope: FastifyInstance, o: ApiOptions): void {
  scope.post('/api/invites', { preHandler: requireAdmin }, async (req, reply) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const admin = req.user as SessionUser;
    const { token, tokenHash } = generateSessionToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const created = await withTx(o.pool, async (c) => {
      // The invited row shows the person on the Members page before they accept. An active or
      // disabled user is left alone: the conditional upsert returns no row.
      const u = await c.query(
        `insert into users (email, role, status, invited_by) values ($1, $2, 'invited', $3)
         on conflict (email) do update set role = excluded.role, invited_by = excluded.invited_by
           where users.status = 'invited'
         returning id`,
        [body.data.email, body.data.role, admin.id],
      );
      if (u.rowCount === 0) return false;
      // Only the newest link works, so a link sent to the wrong place can be replaced.
      await c.query(
        `update invites set expires_at = now()
         where email = $1 and accepted_at is null and expires_at > now()`,
        [body.data.email],
      );
      await c.query(
        `insert into invites (email, role, token_hash, expires_at, created_by)
         values ($1, $2, $3, $4, $5)`,
        [body.data.email, body.data.role, tokenHash, expiresAt, admin.id],
      );
      return true;
    });
    if (!created) return reply.code(409).send({ error: 'user_exists' });
    return reply
      .code(201)
      .send({ url: `${o.appOrigin}/invite/${token}`, expiresAt: expiresAt.toISOString() });
  });

  scope.get<{ Params: { token: string } }>('/api/invites/:token', async (req, reply) => {
    const invite = await findInvite(o, req.params.token);
    if (!invite) return reply.code(404).send({ error: 'invite_invalid' });
    return invite;
  });

  scope.post<{ Params: { token: string } }>('/api/invites/:token/accept', async (req, reply) => {
    const body = acceptBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    // Checked before hashing, so a random token costs one lookup and no argon2 work.
    if (!(await findInvite(o, req.params.token))) {
      return reply.code(404).send({ error: 'invite_invalid' });
    }
    const passwordHash = await hash(body.data.password);
    const session = generateSessionToken();
    const user = await withTx(o.pool, async (c) => {
      // FOR UPDATE makes a concurrent accept wait, then re-check accepted_at and find nothing.
      const inv = await c.query<Invite & { id: string }>(
        `select id, email, role from invites where ${VALID} for update`,
        [hashToken(req.params.token)],
      );
      const i = inv.rows[0];
      if (!i) return null;
      const u = await c.query<SessionUser>(
        `update users set password_hash = $2, status = 'active', role = $3, name = coalesce($4, name)
         where email = $1 and status = 'invited'
         returning id, email, name, role`,
        [i.email, passwordHash, i.role, body.data.name ?? null],
      );
      const row = u.rows[0];
      // Disabled by an admin after the invite went out: the link no longer works.
      if (!row) return null;
      await c.query('update invites set accepted_at = now() where id = $1', [i.id]);
      await c.query(
        `insert into sessions (user_id, token_hash, expires_at, user_agent) values ($1, $2, $3, $4)`,
        [row.id, session.tokenHash, sessionExpiresAt(), req.headers['user-agent'] ?? null],
      );
      return row;
    });
    if (!user) return reply.code(404).send({ error: 'invite_invalid' });
    reply.header('set-cookie', sessionCookie(session.token, o.secureCookies));
    return { user };
  });
}
