import { describe, expect, it } from 'vitest';
import { buildHealthApp } from './health.js';

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

  it('does not serve /mcp yet', async () => {
    const res = await buildHealthApp({ ready: async () => true }).inject('/mcp');
    expect(res.statusCode).toBe(404);
  });
});
