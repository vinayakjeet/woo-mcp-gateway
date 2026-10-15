import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { hostedManifests, type HostedSpec } from './hosted-manifests.js';
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

  describe('hosted objects', () => {
    const config = {
      allowedImagePrefixes: ['fx-mcp:'],
      maxCpuMillis: 500,
      maxMemoryBytes: 256 * 1024 ** 2,
      gatewayNamespace: 'platform',
      gatewayLabels: { 'app.kubernetes.io/name': 'gateway' },
    };
    const spec: HostedSpec = {
      slug: 'fx2',
      image: 'fx-mcp:dev',
      port: 8080,
      path: '/mcp',
      env: [],
      cpu: '200m',
      memory: '128Mi',
    };
    const m = hostedManifests(spec, { MCP_SHARED_TOKEN: 'tok-abc-123' }, config);

    it('applies with PATCH, apply-patch+yaml, the field manager and force', async () => {
      const api = await fakeApi(() => ({ status: 200, body: {} }));
      const kube = kubeClient({ server: api.url, token: async () => 't' });
      try {
        await kube.apply(m.deployment, 'platform');
        const s = api.seen[0]!;
        expect(s.method).toBe('PATCH');
        expect(s.url).toBe(
          '/apis/apps/v1/namespaces/mcp-hosted/deployments/fx2?fieldManager=platform&force=true',
        );
        expect(s.headers['content-type']).toBe('application/apply-patch+yaml');
        expect(JSON.parse(s.body)).toEqual(m.deployment);
      } finally {
        await api.close();
      }
    });

    it('builds the apply path for each kind', async () => {
      const api = await fakeApi(() => ({ status: 201, body: {} }));
      const kube = kubeClient({ server: api.url, token: async () => 't' });
      try {
        for (const o of [m.secret, m.networkPolicy, m.service, m.deployment]) {
          await kube.apply(o, 'platform');
        }
        expect(api.seen.map((s) => s.url.split('?')[0])).toEqual([
          '/api/v1/namespaces/mcp-hosted/secrets/fx2-env',
          '/apis/networking.k8s.io/v1/namespaces/mcp-hosted/networkpolicies/fx2',
          '/api/v1/namespaces/mcp-hosted/services/fx2',
          '/apis/apps/v1/namespaces/mcp-hosted/deployments/fx2',
        ]);
      } finally {
        await api.close();
      }
    });

    it('throws status and reason only on a 422 that quotes the object', async () => {
      const api = await fakeApi(() => ({
        status: 422,
        body: {
          reason: 'Invalid',
          message: `Secret "fx2-env" is invalid: data[DEMO]: ${m.secret.data.MCP_SHARED_TOKEN}`,
          details: { causes: [{ message: 'tok-abc-123' }] },
        },
      }));
      const kube = kubeClient({ server: api.url, token: async () => 't' });
      try {
        const err = await kube.apply(m.secret, 'platform').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(KubeError);
        expect(err).toMatchObject({ status: 422, reason: 'Invalid' });
        const text = `${(err as Error).message} ${JSON.stringify(err)} ${(err as Error).stack}`;
        expect(text).not.toContain('tok-abc-123');
        expect(text).not.toContain(m.secret.data.MCP_SHARED_TOKEN);
      } finally {
        await api.close();
      }
    });

    it('drops a reason that is not a plain word', async () => {
      const api = await fakeApi(() => ({ status: 500, body: { reason: 'leak: s3cr3t value' } }));
      const kube = kubeClient({ server: api.url, token: async () => 't' });
      try {
        const err = await kube.apply(m.secret, 'platform').catch((e: unknown) => e);
        expect(err).toMatchObject({ status: 500, reason: 'Unknown' });
      } finally {
        await api.close();
      }
    });

    it('reads availability and the progress deadline from a Deployment', async () => {
      const api = await fakeApi((s) => {
        if (s.url.endsWith('/gone')) return { status: 404, body: { reason: 'NotFound' } };
        if (s.url.endsWith('/up'))
          return { status: 200, body: { status: { availableReplicas: 1 } } };
        if (s.url.endsWith('/starting')) return { status: 200, body: { status: { replicas: 1 } } };
        if (s.url.endsWith('/late')) {
          return {
            status: 200,
            body: {
              status: {
                conditions: [
                  { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable' },
                  { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' },
                ],
              },
            },
          };
        }
        return { status: 403, body: { reason: 'Forbidden' } };
      });
      const kube = kubeClient({ server: api.url, token: async () => 't' });
      try {
        const get = (n: string) => kube.deploymentStatus('mcp-hosted', n);
        await expect(get('gone')).resolves.toEqual({
          exists: false,
          available: false,
          deadlineExceeded: false,
        });
        await expect(get('up')).resolves.toEqual({
          exists: true,
          available: true,
          deadlineExceeded: false,
        });
        await expect(get('starting')).resolves.toEqual({
          exists: true,
          available: false,
          deadlineExceeded: false,
        });
        await expect(get('late')).resolves.toEqual({
          exists: true,
          available: false,
          deadlineExceeded: true,
        });
        await expect(get('nope')).rejects.toMatchObject({ status: 403 });
        expect(api.seen[0]!.url).toBe('/apis/apps/v1/namespaces/mcp-hosted/deployments/gone');
      } finally {
        await api.close();
      }
    });

    it('returns only the waiting reason of each container', async () => {
      const api = await fakeApi(() => ({
        status: 200,
        body: {
          items: [
            {
              spec: { containers: [{ env: [{ name: 'X', value: 's3cr3t' }] }] },
              status: {
                containerStatuses: [
                  {
                    name: 'server',
                    state: {
                      waiting: {
                        reason: 'ImagePullBackOff',
                        message: 'Back-off pulling image "fx-mcp:dev" s3cr3t',
                      },
                    },
                  },
                  { name: 'other', state: { running: {} } },
                  { name: 'odd', state: { waiting: { reason: 'has spaces and s3cr3t' } } },
                ],
              },
            },
          ],
        },
      }));
      const kube = kubeClient({ server: api.url, token: async () => 't' });
      try {
        const reasons = await kube.podWaitingReasons('mcp-hosted', 'urumi.io/hosted=fx2');
        expect(reasons).toEqual(['ImagePullBackOff']);
        expect(api.seen[0]!.url).toBe(
          '/api/v1/namespaces/mcp-hosted/pods?labelSelector=urumi.io%2Fhosted%3Dfx2',
        );
      } finally {
        await api.close();
      }
    });

    it('lists names with an encoded label selector, for each kind', async () => {
      const api = await fakeApi(() => ({
        status: 200,
        body: { items: [{ metadata: { name: 'a' } }, { metadata: { name: 'b' } }] },
      }));
      const kube = kubeClient({ server: api.url, token: async () => 't' });
      try {
        const sel = 'urumi.io/hosted=fx2';
        await expect(kube.listNames('Deployment', 'mcp-hosted', sel)).resolves.toEqual(['a', 'b']);
        await kube.listNames('Secret', 'mcp-hosted', sel);
        await kube.listNames('Service', 'mcp-hosted', sel);
        await kube.listNames('NetworkPolicy', 'mcp-hosted', sel);
        await kube.listNames('Pod', 'mcp-hosted', sel);
        expect(api.seen.map((s) => s.url)).toEqual([
          '/apis/apps/v1/namespaces/mcp-hosted/deployments?labelSelector=urumi.io%2Fhosted%3Dfx2',
          '/api/v1/namespaces/mcp-hosted/secrets?labelSelector=urumi.io%2Fhosted%3Dfx2',
          '/api/v1/namespaces/mcp-hosted/services?labelSelector=urumi.io%2Fhosted%3Dfx2',
          '/apis/networking.k8s.io/v1/namespaces/mcp-hosted/networkpolicies?labelSelector=urumi.io%2Fhosted%3Dfx2',
          '/api/v1/namespaces/mcp-hosted/pods?labelSelector=urumi.io%2Fhosted%3Dfx2',
        ]);
        expect(api.seen.every((s) => s.method === 'GET')).toBe(true);
      } finally {
        await api.close();
      }
    });

    it('deletes one object at a time and treats 404 as done', async () => {
      const api = await fakeApi((s) =>
        s.url.endsWith('/gone')
          ? { status: 404, body: { reason: 'NotFound' } }
          : s.url.endsWith('/boom')
            ? { status: 500, body: { reason: 'InternalError' } }
            : { status: 200, body: {} },
      );
      const kube = kubeClient({ server: api.url, token: async () => 't' });
      try {
        await expect(kube.deleteObject('Secret', 'mcp-hosted', 'fx2-env')).resolves.toBeUndefined();
        await expect(
          kube.deleteObject('Deployment', 'mcp-hosted', 'gone'),
        ).resolves.toBeUndefined();
        await expect(kube.deleteObject('Service', 'mcp-hosted', 'boom')).rejects.toMatchObject({
          status: 500,
        });
        expect(api.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
          'DELETE /api/v1/namespaces/mcp-hosted/secrets/fx2-env',
          'DELETE /apis/apps/v1/namespaces/mcp-hosted/deployments/gone',
          'DELETE /api/v1/namespaces/mcp-hosted/services/boom',
        ]);
      } finally {
        await api.close();
      }
    });
  });
});
