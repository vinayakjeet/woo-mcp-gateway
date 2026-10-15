import { METRICS_CONTENT_TYPE } from '@woo/core';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

export function buildHealthApp(
  o: { ready(): Promise<boolean>; metrics?: () => string },
  logger: FastifyServerOptions['logger'] = false,
): FastifyInstance {
  const app = Fastify({ logger });
  app.get('/healthz', async () => 'ok');
  app.get('/readyz', async (_req, reply) => {
    const ready = await o.ready().catch(() => false);
    return reply.code(ready ? 200 : 503).send(ready ? 'ready' : 'not ready');
  });
  // On this port only: no Ingress routes it, and the NetworkPolicy admits Prometheus and the kubelet.
  const metrics = o.metrics;
  if (metrics) {
    app.get('/metrics', async (_req, reply) =>
      reply.header('content-type', METRICS_CONTENT_TYPE).send(metrics()),
    );
  }
  return app;
}
