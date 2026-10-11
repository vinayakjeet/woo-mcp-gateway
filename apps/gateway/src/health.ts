import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

export function buildHealthApp(
  o: { ready(): Promise<boolean> },
  logger: FastifyServerOptions['logger'] = false,
): FastifyInstance {
  const app = Fastify({ logger });
  app.get('/healthz', async () => 'ok');
  app.get('/readyz', async (_req, reply) => {
    const ready = await o.ready().catch(() => false);
    return reply.code(ready ? 200 : 503).send(ready ? 'ready' : 'not ready');
  });
  return app;
}
