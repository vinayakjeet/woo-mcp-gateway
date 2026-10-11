import { hash, verify } from '@node-rs/argon2';
import { generateSessionToken, sessionCookie, sessionExpiresAt } from '@woo/core';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';

export type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'member';
  status: 'invited' | 'active' | 'disabled';
  passwordHash: string | null;
};

export type Deps = {
  ping(): Promise<boolean>;
  findUserByEmail(email: string): Promise<UserRow | null>;
  createSession(s: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
  }): Promise<void>;
};

export type PublicConfig = { appOrigin: string; secureCookies: boolean };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const loginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
});

export function buildPublicApp(
  deps: Deps,
  cfg: PublicConfig,
  logger: FastifyServerOptions['logger'] = false,
): FastifyInstance {
  const app = Fastify({ logger });
  // Verified when the user is missing or not active, so response time does not reveal which emails exist.
  const dummyHash = hash('not-a-real-password');

  // SameSite=Lax is the first CSRF defense; this is the second (SPEC 7). Every later route inherits it.
  app.addHook('onRequest', async (req, reply) => {
    if (SAFE_METHODS.has(req.method)) return;
    if (req.headers.origin !== cfg.appOrigin) return reply.code(403).send({ error: 'bad_origin' });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const user = await deps.findUserByEmail(body.data.email);
    const usable = user !== null && user.status === 'active' && user.passwordHash !== null;
    const ok = await verify(
      usable ? user.passwordHash! : await dummyHash,
      body.data.password,
    ).catch(() => false);
    if (!usable || !ok) return reply.code(401).send({ error: 'invalid_credentials' });
    const { token, tokenHash } = generateSessionToken();
    await deps.createSession({
      userId: user.id,
      tokenHash,
      expiresAt: sessionExpiresAt(),
      userAgent: req.headers['user-agent'] ?? null,
    });
    reply.header('set-cookie', sessionCookie(token, cfg.secureCookies));
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  return app;
}

export function buildInternalApp(
  deps: Deps,
  logger: FastifyServerOptions['logger'] = false,
): FastifyInstance {
  const app = Fastify({ logger });
  app.get('/healthz', async () => 'ok');
  app.get('/readyz', async (_req, reply) => {
    const ready = await deps.ping().catch(() => false);
    return reply.code(ready ? 200 : 503).send(ready ? 'ready' : 'not ready');
  });
  return app;
}
