import { createHash, timingSafeEqual } from 'node:crypto';
import { AGENT_JWT_MAX_TTL_S, signAgentJwt } from '@woo/core';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { sessionUser, sidFromCookie } from './api-session.js';

export type IntrospectOptions = {
  pool: Pick<pg.Pool, 'query'>;
  internalSecret: string;
  jwtKey: string;
  gatewayUrl: string;
};

const sha256 = (s: string) => createHash('sha256').update(s).digest();

// SPEC 7 agent delegation. The agent forwards the browser's Cookie header as is, so the sid is
// parsed by the same code as the public API. No live session means no token.
export async function introspectRoutes(
  scope: FastifyInstance,
  o: IntrospectOptions,
): Promise<void> {
  scope.post('/internal/sessions/introspect', async (req, reply) => {
    const given = req.headers['x-internal-secret'];
    // Digests give timingSafeEqual equal lengths, so the time taken does not leak the secret.
    if (typeof given !== 'string' || !timingSafeEqual(sha256(given), sha256(o.internalSecret)))
      return reply.code(403).send({ error: 'forbidden' });
    const sid = sidFromCookie(req.headers.cookie);
    const user = sid ? await sessionUser(o.pool, sid) : null;
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    const now = Math.floor(Date.now() / 1000);
    const token = signAgentJwt({ key: o.jwtKey, userId: user.id, audience: o.gatewayUrl, now });
    return {
      user,
      token,
      expiresAt: new Date((now + AGENT_JWT_MAX_TTL_S) * 1000).toISOString(),
    };
  });
}
