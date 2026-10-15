import { hash, verify } from '@node-rs/argon2';
import rateLimit from '@fastify/rate-limit';
import {
  errorCode,
  generateSessionToken,
  requestIdOptions,
  sessionCookie,
  sessionExpiresAt,
} from '@woo/core';
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

const LOGIN_PER_IP = 10;
const LOGIN_PER_EMAIL = 5;
const LOGIN_WINDOW = '1 minute';

// Drizzle error messages contain SQL params, so the default handler (which logs the whole error)
// is replaced: only the code and the route are logged.
function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: { statusCode?: number }, req, reply) => {
    const status =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    req.log.error({ code: errorCode(err), route: req.routeOptions.url }, 'request failed');
    const error =
      status === 429 ? 'rate_limited' : status === 500 ? 'internal_error' : 'bad_request';
    return reply.code(status).send({ error });
  });
}

const emailKey = (body: unknown): string =>
  String((body as { email?: unknown } | null)?.email ?? '')
    .trim()
    .toLowerCase();

export function buildPublicApp(
  deps: Deps,
  cfg: PublicConfig,
  logger: FastifyServerOptions['logger'] = false,
): FastifyInstance {
  // One hop: Traefik appends the client address, so the last X-Forwarded-For entry is the real one.
  // Trusting the whole header would let a client pick its own rate-limit bucket.
  const app = Fastify({ logger, ...requestIdOptions, trustProxy: (_addr, hop) => hop < 1 });
  installErrorHandler(app);
  // Verified when the user is missing or not active, so response time does not reveal which emails exist.
  // The catch keeps a failed hash from becoming an unhandled rejection at startup; verify then fails closed.
  const dummyHash = hash('not-a-real-password').catch(() => '');

  // SameSite=Lax is the first CSRF defense; this is the second (SPEC 7). Every later route inherits it.
  app.addHook('onRequest', async (req, reply) => {
    if (SAFE_METHODS.has(req.method)) return;
    if (req.headers.origin !== cfg.appOrigin) return reply.code(403).send({ error: 'bad_origin' });
  });

  // The plugin must load before the route is declared, so both live in one scope.
  // Hooks and the error handler set on the root above are inherited by it.
  app.register(async (scope) => {
    await scope.register(rateLimit, { global: false });
    const emailLimit = scope.createRateLimit({
      max: LOGIN_PER_EMAIL,
      timeWindow: LOGIN_WINDOW,
      keyGenerator: (req) => emailKey(req.body),
    });

    scope.post(
      '/api/auth/login',
      { config: { rateLimit: { max: LOGIN_PER_IP, timeWindow: LOGIN_WINDOW } } },
      async (req, reply) => {
        const body = loginBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'bad_request' });
        const email = await emailLimit(req);
        // isAllowed is true only for allow-listed keys; a counted request is within the limit until isExceeded.
        if (!email.isAllowed && email.isExceeded) {
          return reply
            .code(429)
            .header('retry-after', String(email.ttlInSeconds))
            .send({ error: 'rate_limited' });
        }
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
      },
    );
  });

  return app;
}

export function buildInternalApp(
  deps: Deps,
  logger: FastifyServerOptions['logger'] = false,
): FastifyInstance {
  const app = Fastify({ logger, ...requestIdOptions });
  installErrorHandler(app);
  app.get('/healthz', async () => 'ok');
  app.get('/readyz', async (_req, reply) => {
    const ready = await deps.ping().catch(() => false);
    return reply.code(ready ? 200 : 503).send(ready ? 'ready' : 'not ready');
  });
  return app;
}
