import { hostedRequests, parseHostedInput, type HostedConfig } from './hosted-input.js';

export const HOSTED_NAMESPACE = 'mcp-hosted';
export const HOSTED_LABEL = 'urumi.io/hosted';

// SPEC 15 gives Node services uid 10001. A fixed uid lets images that default to root still run
// under runAsNonRoot.
const UID = 10001;
// SPEC 16: the five private and link-local ranges that public egress must not reach.
const PRIVATE_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
];

export type HostedSpec = {
  slug: string;
  image: string;
  port: number;
  path: string;
  env: { name: string; value: string }[];
  cpu: string;
  memory: string;
};

type Meta = { name: string; namespace: string; labels: Record<string, string> };
type Selector = { matchLabels: Record<string, string> };
type TcpPort = { protocol: 'TCP'; port: number };
type TcpProbe = {
  tcpSocket: { port: number };
  initialDelaySeconds: number;
  periodSeconds: number;
  failureThreshold: number;
};

export type SecretObject = {
  apiVersion: 'v1';
  kind: 'Secret';
  metadata: Meta;
  type: 'Opaque';
  data: Record<string, string>;
};
export type ServiceObject = {
  apiVersion: 'v1';
  kind: 'Service';
  metadata: Meta;
  spec: {
    type: 'ClusterIP';
    selector: Record<string, string>;
    ports: { name: string; port: number; targetPort: number; protocol: 'TCP' }[];
  };
};
export type NetworkPolicyObject = {
  apiVersion: 'networking.k8s.io/v1';
  kind: 'NetworkPolicy';
  metadata: Meta;
  spec: {
    podSelector: Selector;
    policyTypes: ('Ingress' | 'Egress')[];
    ingress: {
      from: { namespaceSelector: Selector; podSelector: Selector }[];
      ports: TcpPort[];
    }[];
    egress: { to: { ipBlock: { cidr: string; except: string[] } }[]; ports: TcpPort[] }[];
  };
};
export type DeploymentObject = {
  apiVersion: 'apps/v1';
  kind: 'Deployment';
  metadata: Meta;
  spec: {
    replicas: 1;
    progressDeadlineSeconds: number;
    selector: Selector;
    template: {
      metadata: { labels: Record<string, string> };
      spec: {
        automountServiceAccountToken: false;
        enableServiceLinks: false;
        terminationGracePeriodSeconds: number;
        securityContext: {
          runAsNonRoot: true;
          runAsUser: number;
          runAsGroup: number;
          seccompProfile: { type: 'RuntimeDefault' };
        };
        containers: {
          name: string;
          image: string;
          imagePullPolicy: 'IfNotPresent';
          ports: { name: string; containerPort: number }[];
          env: { name: string; value: string }[];
          envFrom: { secretRef: { name: string } }[];
          resources: {
            requests: { cpu: string; memory: string };
            limits: { cpu: string; memory: string };
          };
          securityContext: {
            allowPrivilegeEscalation: false;
            capabilities: { drop: ['ALL'] };
            readOnlyRootFilesystem: true;
          };
          readinessProbe: TcpProbe;
          livenessProbe: TcpProbe;
          volumeMounts: { name: string; mountPath: string }[];
        }[];
        volumes: { name: string; emptyDir: { sizeLimit: string } }[];
      };
    };
  };
};
export type HostedObject = SecretObject | ServiceObject | NetworkPolicyObject | DeploymentObject;

export const hostedUrl = (slug: string, port: number, path: string): string =>
  `http://${slug}.${HOSTED_NAMESPACE}.svc.cluster.local:${port}${path}`;

const b64 = (v: string) => Buffer.from(v, 'utf8').toString('base64');

// Rows are written by the API, but the apply step does not trust that: it checks the spec again
// against the current config, so a row written around the API, or a prefix list that has shrunk
// since the row was made, cannot reach the cluster. The Secret values are not part of this check
// and are never put in the error.
function assertSpec(spec: HostedSpec, config: HostedConfig): void {
  const r = parseHostedInput(config, { ...spec, secretEnv: [] });
  if (!r.ok) {
    throw new Error(
      `invalid hosted spec for ${spec.slug}: ${r.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
  }
}

export function hostedManifests(
  spec: HostedSpec,
  secretEnv: Record<string, string>,
  config: HostedConfig,
): {
  secret: SecretObject;
  networkPolicy: NetworkPolicyObject;
  service: ServiceObject;
  deployment: DeploymentObject;
} {
  assertSpec(spec, config);
  const { slug, port } = spec;
  const selector = { [HOSTED_LABEL]: slug };
  const labels = { ...selector, 'app.kubernetes.io/managed-by': 'control-plane' };
  const meta = (name: string): Meta => ({ name, namespace: HOSTED_NAMESPACE, labels });
  const secretName = `${slug}-env`;
  const probe = (initialDelaySeconds: number, periodSeconds: number): TcpProbe => ({
    tcpSocket: { port },
    initialDelaySeconds,
    periodSeconds,
    failureThreshold: 3,
  });

  return {
    secret: {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: meta(secretName),
      type: 'Opaque',
      data: Object.fromEntries(Object.entries(secretEnv).map(([k, v]) => [k, b64(v)])),
    },
    // The policy is applied before the Deployment, so the pod never starts unrestricted.
    // DNS egress comes from the namespace's allow-dns policy.
    networkPolicy: {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: meta(slug),
      spec: {
        podSelector: { matchLabels: selector },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.gatewayNamespace },
                },
                podSelector: { matchLabels: config.gatewayLabels },
              },
            ],
            ports: [{ protocol: 'TCP', port }],
          },
        ],
        egress: [
          {
            to: [{ ipBlock: { cidr: '0.0.0.0/0', except: PRIVATE_RANGES } }],
            ports: [{ protocol: 'TCP', port: 443 }],
          },
        ],
      },
    },
    service: {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: meta(slug),
      spec: {
        type: 'ClusterIP',
        selector,
        ports: [{ name: 'mcp', port, targetPort: port, protocol: 'TCP' }],
      },
    },
    deployment: {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: meta(slug),
      spec: {
        replicas: 1,
        progressDeadlineSeconds: 300,
        selector: { matchLabels: selector },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            terminationGracePeriodSeconds: 10,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: UID,
              runAsGroup: UID,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'server',
                image: spec.image,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ name: 'mcp', containerPort: port }],
                env: spec.env.map((e) => ({ name: e.name, value: e.value })),
                envFrom: [{ secretRef: { name: secretName } }],
                resources: {
                  requests: hostedRequests(spec),
                  limits: { cpu: spec.cpu, memory: spec.memory },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'] },
                  readOnlyRootFilesystem: true,
                },
                // A TCP probe needs no token and no request body. An HTTP probe on the MCP path
                // would need a POST with the bearer token.
                readinessProbe: probe(1, 5),
                livenessProbe: probe(10, 20),
                volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
              },
            ],
            volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }],
          },
        },
      },
    },
  };
}
