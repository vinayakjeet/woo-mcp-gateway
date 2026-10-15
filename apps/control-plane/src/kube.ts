import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import type { HostedObject } from './hosted-manifests.js';

export type HostedKind = HostedObject['kind'];
export type DeploymentState = { exists: boolean; available: boolean; deadlineExceeded: boolean };

export interface Kube {
  applyNamespace(name: string, labels: Record<string, string>): Promise<void>;
  namespaceExists(name: string): Promise<boolean>;
  deleteNamespace(name: string): Promise<void>;
  // Server-side apply of one hosted object. force=true takes over fields from other managers.
  apply(obj: HostedObject, fieldManager: string): Promise<void>;
  deploymentStatus(ns: string, name: string): Promise<DeploymentState>;
  // Container waiting reasons of the pods under a label selector, such as ImagePullBackOff.
  podWaitingReasons(ns: string, selector: string): Promise<string[]>;
  // Pods are listed so a delete can wait for them, but are never deleted directly.
  listNames(kind: HostedKind | 'Pod', ns: string, selector: string): Promise<string[]>;
  deleteObject(kind: HostedKind, ns: string, name: string): Promise<void>;
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
type Answer = { status: number; reason: string; json: unknown };

// Kubernetes reasons and waiting reasons are single CamelCase words. Anything else is dropped, so
// a body that quotes an object or an env value cannot leak through a status or a reason.
const WORD = /^[A-Za-z]{1,64}$/;
const word = (v: unknown): string | null => (typeof v === 'string' && WORD.test(v) ? v : null);

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
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            // Not JSON: keep the default reason.
          }
          const reason = word((json as { reason?: unknown } | null)?.reason) ?? 'Unknown';
          resolve({ status: res.statusCode ?? 0, reason, json });
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
  const collection = (kind: HostedKind | 'Pod', namespace: string): string => {
    const n = encodeURIComponent(namespace);
    switch (kind) {
      case 'Secret':
        return `/api/v1/namespaces/${n}/secrets`;
      case 'Service':
        return `/api/v1/namespaces/${n}/services`;
      case 'Pod':
        return `/api/v1/namespaces/${n}/pods`;
      case 'NetworkPolicy':
        return `/apis/networking.k8s.io/v1/namespaces/${n}/networkpolicies`;
      case 'Deployment':
        return `/apis/apps/v1/namespaces/${n}/deployments`;
    }
  };
  const named = (kind: HostedKind, namespace: string, name: string) =>
    `${collection(kind, namespace)}/${encodeURIComponent(name)}`;
  const list = async (kind: HostedKind | 'Pod', namespace: string, selector: string) => {
    const a = await request(
      'GET',
      `${collection(kind, namespace)}?labelSelector=${encodeURIComponent(selector)}`,
    );
    if (a.status !== 200) throw new KubeError(a.status, a.reason);
    return (a.json as { items?: Item[] } | null)?.items ?? [];
  };
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
    async apply(obj, fieldManager) {
      const { name, namespace } = obj.metadata;
      const q = `fieldManager=${encodeURIComponent(fieldManager)}&force=true`;
      const a = await request('PATCH', `${named(obj.kind, namespace, name)}?${q}`, obj);
      if (a.status !== 200 && a.status !== 201) throw new KubeError(a.status, a.reason);
    },
    async deploymentStatus(namespace, name) {
      const a = await request('GET', named('Deployment', namespace, name));
      if (a.status === 404) return { exists: false, available: false, deadlineExceeded: false };
      if (a.status !== 200) throw new KubeError(a.status, a.reason);
      const status = (a.json as DeploymentBody | null)?.status;
      return {
        exists: true,
        available: (status?.availableReplicas ?? 0) >= 1,
        deadlineExceeded: (status?.conditions ?? []).some(
          (c) =>
            c.type === 'Progressing' &&
            c.status === 'False' &&
            c.reason === 'ProgressDeadlineExceeded',
        ),
      };
    },
    async podWaitingReasons(namespace, selector) {
      const reasons: string[] = [];
      for (const pod of await list('Pod', namespace, selector)) {
        for (const c of pod.status?.containerStatuses ?? []) {
          const r = word(c.state?.waiting?.reason);
          if (r) reasons.push(r);
        }
      }
      return reasons;
    },
    async listNames(kind, namespace, selector) {
      const items = await list(kind, namespace, selector);
      return items.map((i) => i.metadata?.name).filter((n): n is string => typeof n === 'string');
    },
    async deleteObject(kind, namespace, name) {
      const a = await request('DELETE', named(kind, namespace, name));
      if (a.status === 200 || a.status === 202 || a.status === 404) return;
      throw new KubeError(a.status, a.reason);
    },
  };
}

type Item = {
  metadata?: { name?: unknown };
  status?: { containerStatuses?: { state?: { waiting?: { reason?: unknown } } }[] };
};

type DeploymentBody = {
  status?: {
    availableReplicas?: number;
    conditions?: { type?: string; status?: string; reason?: string }[];
  };
};
