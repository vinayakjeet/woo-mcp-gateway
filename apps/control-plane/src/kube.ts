import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';

export interface Kube {
  applyNamespace(name: string, labels: Record<string, string>): Promise<void>;
  namespaceExists(name: string): Promise<boolean>;
  deleteNamespace(name: string): Promise<void>;
}

// Only the status and the API's reason word leave this module, never a response body.
export class KubeError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`Kubernetes API answered ${status} ${reason}`);
  }
}

type KubeConfig = { server: string; token: () => Promise<string>; ca?: Buffer };
type Answer = { status: number; reason: string };

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

// Projected ServiceAccount tokens rotate, so the file is read for every request.
export async function inClusterKube(): Promise<Kube> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  if (!host) throw new Error('KUBERNETES_SERVICE_HOST is unset: not running in a cluster');
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  const ca = await readFile(`${SA}/ca.crt`).catch(() => {
    throw new Error(`no ServiceAccount CA at ${SA}: is automountServiceAccountToken on?`);
  });
  return kubeClient({
    server: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
    ca,
    token: async () => (await readFile(`${SA}/token`, 'utf8')).trim(),
  });
}

export function kubeClient(cfg: KubeConfig): Kube {
  async function request(method: string, path: string, patch?: unknown): Promise<Answer> {
    const url = new URL(path, cfg.server);
    const payload = patch === undefined ? undefined : JSON.stringify(patch);
    const opts: https.RequestOptions = {
      method,
      timeout: 15_000,
      headers: {
        authorization: `Bearer ${await cfg.token()}`,
        accept: 'application/json',
        ...(payload === undefined
          ? {}
          : {
              'content-type': 'application/apply-patch+yaml',
              'content-length': Buffer.byteLength(payload),
            }),
      },
    };
    return new Promise((resolve, reject) => {
      const onRes = (res: http.IncomingMessage) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => {
          let reason = 'Unknown';
          try {
            reason = (JSON.parse(text) as { reason?: string }).reason ?? reason;
          } catch {
            // Not JSON: keep the default reason.
          }
          resolve({ status: res.statusCode ?? 0, reason });
        });
      };
      const req =
        url.protocol === 'https:'
          ? https.request(url, { ...opts, ca: cfg.ca }, onRes)
          : http.request(url, opts, onRes);
      req.on('timeout', () => req.destroy(new Error('Kubernetes API timed out')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  const ns = (name: string) => `/api/v1/namespaces/${encodeURIComponent(name)}`;
  return {
    async applyNamespace(name, labels) {
      const a = await request('PATCH', `${ns(name)}?fieldManager=control-plane&force=true`, {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name, labels },
      });
      if (a.status !== 200 && a.status !== 201) throw new KubeError(a.status, a.reason);
    },
    async namespaceExists(name) {
      const a = await request('GET', ns(name));
      if (a.status === 404) return false;
      if (a.status === 200) return true;
      throw new KubeError(a.status, a.reason);
    },
    async deleteNamespace(name) {
      const a = await request('DELETE', ns(name));
      if (a.status === 200 || a.status === 202 || a.status === 404) return;
      throw new KubeError(a.status, a.reason);
    },
  };
}
