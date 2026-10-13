import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { KubeError, kubeClient } from './kube.js';

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

async function fakeApi(answer: (s: Seen) => { status: number; body?: unknown }) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const s = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      seen.push(s);
      const a = answer(s);
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(a.body === undefined ? '' : JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    seen,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('kubeClient', () => {
  it('applies a namespace server side, reading the token for each request', async () => {
    const api = await fakeApi(() => ({ status: 201, body: { kind: 'Namespace' } }));
    let n = 0;
    const kube = kubeClient({ server: api.url, token: async () => `tok-${++n}` });
    try {
      await kube.applyNamespace('store-x', { 'urumi.io/store': 'x' });
      await kube.applyNamespace('store-x', { 'urumi.io/store': 'x' });
      const s = api.seen[0]!;
      expect(s.method).toBe('PATCH');
      expect(s.url).toBe('/api/v1/namespaces/store-x?fieldManager=control-plane&force=true');
      expect(s.headers['content-type']).toBe('application/apply-patch+yaml');
      expect(JSON.parse(s.body)).toEqual({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: 'store-x', labels: { 'urumi.io/store': 'x' } },
      });
      expect(api.seen.map((x) => x.headers.authorization)).toEqual([
        'Bearer tok-1',
        'Bearer tok-2',
      ]);
    } finally {
      await api.close();
    }
  });

  it('says whether a namespace exists and throws on other answers', async () => {
    const api = await fakeApi((s) =>
      s.url.endsWith('/here')
        ? { status: 200, body: {} }
        : s.url.endsWith('/gone')
          ? { status: 404, body: { reason: 'NotFound' } }
          : { status: 403, body: { reason: 'Forbidden' } },
    );
    const kube = kubeClient({ server: api.url, token: async () => 't' });
    try {
      await expect(kube.namespaceExists('here')).resolves.toBe(true);
      await expect(kube.namespaceExists('gone')).resolves.toBe(false);
      const err = await kube.namespaceExists('secret').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KubeError);
      expect(err).toMatchObject({ status: 403, reason: 'Forbidden' });
    } finally {
      await api.close();
    }
  });

  it('treats a namespace already gone as deleted', async () => {
    const api = await fakeApi((s) =>
      s.url.endsWith('/gone')
        ? { status: 404, body: { reason: 'NotFound' } }
        : s.url.endsWith('/live')
          ? { status: 200, body: { status: { phase: 'Terminating' } } }
          : { status: 500, body: { reason: 'InternalError' } },
    );
    const kube = kubeClient({ server: api.url, token: async () => 't' });
    try {
      await expect(kube.deleteNamespace('gone')).resolves.toBeUndefined();
      await expect(kube.deleteNamespace('live')).resolves.toBeUndefined();
      await expect(kube.deleteNamespace('boom')).rejects.toMatchObject({ status: 500 });
      expect(api.seen.map((s) => s.method)).toEqual(['DELETE', 'DELETE', 'DELETE']);
    } finally {
      await api.close();
    }
  });
});
