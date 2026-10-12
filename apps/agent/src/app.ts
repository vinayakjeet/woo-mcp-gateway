import { errorCode } from '@woo/core';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { UserFacingError } from './errors.js';
import type { GatewaySession } from './gateway.js';
import type { SessionInfo } from './introspect.js';
import { runTurn, type AgentEvent, type TurnStats } from './loop.js';
import type { Completer } from './model.js';
import { sseFrame } from './sse.js';

// The agent JWT lives 300 s. Ending the turn first means every gateway call carries a valid token.
export const TURN_DEADLINE_MS = 240_000;
// Proxies drop idle streams; a comment every 15 s keeps a slow turn open.
export const KEEPALIVE_MS = 15_000;

export type AppDeps = {
  appOrigin: string;
  introspect(cookie: string): Promise<SessionInfo | null>;
  connect(token: string): Promise<GatewaySession>;
  model(): Completer;
  now?: () => Date;
  turnDeadlineMs?: number;
  keepaliveMs?: number;
};

const chatBody = z
  .object({
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(16_000) }))
      .min(1)
      .max(200),
  })
  .refine((b) => b.messages.at(-1)?.role === 'user');

export function buildApp(
  deps: AppDeps,
  logger: FastifyServerOptions['logger'] = false,
): FastifyInstance {
  const app = Fastify({ logger });
  app.get('/healthz', async () => 'ok');
  // SPEC 13 gives the agent no database, so there is no schema version to wait for.
  app.get('/readyz', async () => 'ready');

  app.post('/api/chat', async (req, reply) => {
    // SPEC 7: state-changing requests carry the app Origin. A chat turn can create products.
    if (req.headers.origin !== deps.appOrigin) return reply.code(403).send({ error: 'bad_origin' });
    const body = chatBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    let session: SessionInfo | null = null;
    if (req.headers.cookie) {
      try {
        session = await deps.introspect(req.headers.cookie);
      } catch (err) {
        req.log.error({ code: errorCode(err) }, 'session introspection failed');
        return reply.code(502).send({ error: 'session_check_failed' });
      }
    }
    if (!session) return reply.code(401).send({ error: 'unauthenticated' });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    // Headers go out now, so the browser sees the stream before the first event.
    res.flushHeaders();
    const deadlineMs = deps.turnDeadlineMs ?? TURN_DEADLINE_MS;
    const gone = new AbortController();
    const deadline = AbortSignal.timeout(deadlineMs);
    const signal = AbortSignal.any([gone.signal, deadline]);
    res.on('close', () => gone.abort());
    const open = () => !res.writableEnded && !res.destroyed;
    const send = (e: AgentEvent) => {
      if (open()) res.write(sseFrame(e));
    };
    const keepalive = setInterval(() => {
      if (open()) res.write(': keepalive\n\n');
    }, deps.keepaliveMs ?? KEEPALIVE_MS);
    const started = Date.now();
    let stats: TurnStats | null = null;
    let outcome = 'ok';
    let gateway: GatewaySession | null = null;
    try {
      gateway = await deps.connect(session.token).catch((err: unknown) => {
        throw new UserFacingError('Could not connect to the gateway.', { cause: err });
      });
      stats = await runTurn({
        messages: body.data.messages,
        email: session.user.email,
        now: deps.now?.() ?? new Date(),
        tools: gateway,
        model: deps.model(),
        emit: send,
        signal,
      });
    } catch (err) {
      if (gone.signal.aborted) {
        outcome = 'client_closed';
      } else if (deadline.aborted) {
        outcome = 'deadline';
        send({
          type: 'error',
          message: `This turn took longer than ${Math.ceil(deadlineMs / 1000)} s and was stopped.`,
        });
      } else if (err instanceof UserFacingError) {
        outcome = 'error';
        send({ type: 'error', message: err.message });
      } else {
        outcome = 'internal_error';
        send({ type: 'error', message: 'The agent failed. Try again in a moment.' });
      }
      // Messages can carry tool data. errorCode follows the cause chain to the code.
      req.log.warn({ code: errorCode(err), outcome }, 'chat turn failed');
    } finally {
      clearInterval(keepalive);
      await gateway?.close().catch(() => {});
      res.end();
      req.log.info(
        { user: session.user.id, ...(stats ?? {}), ms: Date.now() - started, outcome },
        'chat turn',
      );
    }
  });
  return app;
}
