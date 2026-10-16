import { clearSessionCookie, hashToken } from '@woo/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { ApiOptions } from './api.js';

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'member';
};

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Session tokens are 32 random bytes in base64url (core sessions.ts).
const SID_RE = /(?:^|;\s*)sid=([A-Za-z0-9_-]{43})(?:;|$)/;

export function sidFromCookie(header: string | undefined): string | null {
  return header ? (SID_RE.exec(header)?.[1] ?? null) : null;
}

// A malformed id is answered like an unknown one (404), never as a Postgres cast error.
export function parseId(params: unknown): string | null {
  const id = (params as { id?: unknown } | null)?.id;
  return typeof id === 'string' && UUID_RE.test(id) ? id.toLowerCase() : null;
}

export async function sessionUser(
  db: Pick<pg.Pool, 'query'>,
  sid: string,
): Promise<SessionUser | null> {
  const r = await db.query<SessionUser>(
    `select u.id, u.email, u.name, u.role from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now() and u.status = 'active'`,
    [hashToken(sid)],
  );
  return r.rows[0] ?? null;
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: 'unauthenticated' });
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: 'unauthenticated' });
  if (req.user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
}

export function sessionRoutes(scope: FastifyInstance, o: ApiOptions): void {
  scope.post('/api/auth/logout', async (req, reply) => {
    const sid = sidFromCookie(req.headers.cookie);
    if (sid) await o.pool.query('delete from sessions where token_hash = $1', [hashToken(sid)]);
    return reply.code(204).header('set-cookie', clearSessionCookie(o.secureCookies)).send();
  });
  scope.get('/api/me', { preHandler: requireUser }, async (req) => ({ user: req.user }));
  scope.get('/api/config', async () => ({
    gatewayUrl: o.gatewayUrl,
    version: o.version,
    oauthEnabled: o.oauthEnabled === true,
  }));
}
