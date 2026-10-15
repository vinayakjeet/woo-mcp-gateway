import { describe, expect, it } from 'vitest';
import { buildHealthApp } from './health.js';
import { gatewayLogger } from './logger.js';

describe('buildHealthApp', () => {
  it('answers /healthz without asking the readiness check', async () => {
    const app = buildHealthApp({
      ready: async () => {
        throw new Error('must not be called');
      },
    });
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok');
  });

  it('is ready when the check says so', async () => {
    const res = await buildHealthApp({ ready: async () => true }).inject('/readyz');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ready');
  });

  it('is not ready when the check says false', async () => {
    const res = await buildHealthApp({ ready: async () => false }).inject('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('not ready');
  });

  it('is not ready when the check throws', async () => {
    const res = await buildHealthApp({
      ready: async () => {
        throw new Error('db down');
      },
    }).inject('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('not ready');
  });

  it('does not serve /mcp on the health port', async () => {
    const res = await buildHealthApp({ ready: async () => true }).inject('/mcp');
    expect(res.statusCode).toBe(404);
  });
});

// Typed as the serializer shape, but returns the whole object.
const raw = (r: unknown) => r as { method?: string; statusCode?: number };

describe('gatewayLogger', () => {
  it('redacts cookies, authorization and set-cookie like the control-plane', async () => {
    const lines: string[] = [];
    const app = buildHealthApp(
      { ready: async () => true },
      {
        ...gatewayLogger,
        // Fastify's default req/res serializers already drop headers; identity ones show the redact list works.
        serializers: { req: raw, res: raw },
        stream: { write: (s: string) => void lines.push(s) },
      },
    );
    app.log.info(
      {
        req: { headers: { authorization: 'Bearer LEAKMARKER', cookie: 'sid=LEAKMARKER' } },
        res: { headers: { 'set-cookie': 'sid=LEAKMARKER' } },
      },
      'probe',
    );
    const out = lines.join('');
    expect(out).toContain('[Redacted]');
    expect(out).not.toContain('LEAKMARKER');
  });
});

describe('/metrics', () => {
  it('serves /metrics as Prometheus text when a renderer is given', async () => {
    const app = buildHealthApp({ ready: async () => true, metrics: () => 'x_total 1\n' });
    const res = await app.inject('/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.body).toBe('x_total 1\n');
  });

  it('answers 404 for /metrics when there is no renderer', async () => {
    const res = await buildHealthApp({ ready: async () => true }).inject('/metrics');
    expect(res.statusCode).toBe(404);
  });
});
