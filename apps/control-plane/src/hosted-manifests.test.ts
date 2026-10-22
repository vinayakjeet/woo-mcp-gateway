import { describe, expect, it } from 'vitest';
import type { HostedConfig } from './hosted-input.js';
import {
  HOSTED_LABEL,
  HOSTED_NAMESPACE,
  hostedManifests,
  hostedUrl,
  type HostedSpec,
} from './hosted-manifests.js';

const config: HostedConfig = {
  allowedImagePrefixes: ['fx-mcp:'],
  maxCpuMillis: 500,
  maxMemoryBytes: 256 * 1024 ** 2,
  gatewayNamespace: 'platform',
  gatewayLabels: { 'app.kubernetes.io/name': 'gateway', 'app.kubernetes.io/instance': 'platform' },
};
const spec: HostedSpec = {
  slug: 'fx2',
  image: 'fx-mcp:dev',
  port: 8080,
  path: '/mcp',
  env: [
    { name: 'FX_BASE_URL', value: 'https://api.frankfurter.app' },
    { name: 'LOG_LEVEL', value: 'info' },
  ],
  cpu: '200m',
  memory: '128Mi',
};
const secretEnv = { MCP_SHARED_TOKEN: 'tok-abc-123', DEMO_SECRET: 's3cr3t-xyz' };

const build = (over: Partial<HostedSpec> = {}, secrets: Record<string, string> = secretEnv) =>
  hostedManifests({ ...spec, ...over }, secrets, config);

const podOf = (m: ReturnType<typeof build>) => m.deployment.spec.template.spec;
const pod = () => podOf(build());
const container = () => pod().containers[0]!;

describe('labels and namespace', () => {
  it('puts every object in mcp-hosted with the hosted and managed-by labels', () => {
    const m = build();
    for (const o of [m.secret, m.networkPolicy, m.service, m.deployment]) {
      expect(o.metadata.namespace).toBe(HOSTED_NAMESPACE);
      expect(o.metadata.labels).toMatchObject({
        [HOSTED_LABEL]: 'fx2',
        'app.kubernetes.io/managed-by': 'control-plane',
      });
    }
    expect(HOSTED_NAMESPACE).toBe('mcp-hosted');
    expect(HOSTED_LABEL).toBe('urumi.io/hosted');
  });
  it('names the Deployment, Service and NetworkPolicy after the slug and the Secret slug-env', () => {
    const m = build();
    expect(m.deployment.metadata.name).toBe('fx2');
    expect(m.service.metadata.name).toBe('fx2');
    expect(m.networkPolicy.metadata.name).toBe('fx2');
    expect(m.secret.metadata.name).toBe('fx2-env');
  });
  it('labels the pod template and selects on the hosted label only', () => {
    const d = build().deployment;
    expect(d.spec.template.metadata.labels[HOSTED_LABEL]).toBe('fx2');
    expect(d.spec.selector.matchLabels).toEqual({ [HOSTED_LABEL]: 'fx2' });
  });
});

describe('pod security (pod security, decision 14)', () => {
  it('sets the pod security context field by field', () => {
    expect(pod().securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      seccompProfile: { type: 'RuntimeDefault' },
    });
  });
  it('sets the container security context field by field', () => {
    expect(container().securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      readOnlyRootFilesystem: true,
    });
  });
  it('mounts an emptyDir /tmp with a size limit on the read-only root', () => {
    expect(container().volumeMounts).toEqual([{ name: 'tmp', mountPath: '/tmp' }]);
    expect(pod().volumes).toEqual([{ name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }]);
  });
  it('turns off the service account token and service links', () => {
    expect(pod().automountServiceAccountToken).toBe(false);
    expect(pod().enableServiceLinks).toBe(false);
  });
  it('asks for nothing the restricted profile refuses', () => {
    const p = pod();
    for (const k of ['hostNetwork', 'hostPID', 'hostIPC', 'serviceAccountName', 'nodeName']) {
      expect(p).not.toHaveProperty(k);
    }
    for (const v of p.volumes) expect(v).not.toHaveProperty('hostPath');
    expect(container().ports).toEqual([{ name: 'mcp', containerPort: 8080 }]);
    expect(container().securityContext).not.toHaveProperty('privileged');
  });
  it('pins the pull policy, grace period, replicas and progress deadline', () => {
    const d = build().deployment;
    expect(container().imagePullPolicy).toBe('IfNotPresent');
    expect(pod().terminationGracePeriodSeconds).toBe(10);
    expect(d.spec.progressDeadlineSeconds).toBe(300);
    expect(d.spec.replicas).toBe(1);
  });
  it('runs the image given, as one argv entry with no command override', () => {
    expect(container().image).toBe('fx-mcp:dev');
    expect(container()).not.toHaveProperty('command');
    expect(container()).not.toHaveProperty('args');
  });
});

describe('resources and probes', () => {
  it('sets limits as given and requests at 20m and 64Mi', () => {
    expect(container().resources).toEqual({
      requests: { cpu: '20m', memory: '64Mi' },
      limits: { cpu: '200m', memory: '128Mi' },
    });
  });
  it('lowers a request to a smaller limit', () => {
    const r = podOf(build({ cpu: '10m', memory: '32Mi' })).containers[0]!.resources;
    expect(r).toEqual({
      requests: { cpu: '10m', memory: '32Mi' },
      limits: { cpu: '10m', memory: '32Mi' },
    });
  });
  it('uses tcpSocket readiness and liveness on the port', () => {
    const c = container();
    expect(c.readinessProbe.tcpSocket).toEqual({ port: 8080 });
    expect(c.livenessProbe.tcpSocket).toEqual({ port: 8080 });
    expect(c.livenessProbe.periodSeconds).toBe(20);
    expect(c.livenessProbe.failureThreshold).toBe(3);
    expect(c.readinessProbe).not.toHaveProperty('httpGet');
  });
  it('follows a port other than 8080 everywhere', () => {
    const m = build({ port: 9090 });
    const c = podOf(m).containers[0]!;
    expect(c.ports[0]!.containerPort).toBe(9090);
    expect(c.readinessProbe.tcpSocket.port).toBe(9090);
    expect(m.service.spec.ports[0]).toMatchObject({ port: 9090, targetPort: 9090 });
    expect(m.networkPolicy.spec.ingress[0]!.ports).toEqual([{ protocol: 'TCP', port: 9090 }]);
  });
});

describe('env', () => {
  it('writes base64 data for every value and never stringData', () => {
    const s = build().secret;
    expect(s.type).toBe('Opaque');
    expect(s).not.toHaveProperty('stringData');
    expect(Object.keys(s.data).sort()).toEqual(['DEMO_SECRET', 'MCP_SHARED_TOKEN']);
    expect(Buffer.from(s.data.DEMO_SECRET!, 'base64').toString('utf8')).toBe('s3cr3t-xyz');
    expect(Buffer.from(s.data.MCP_SHARED_TOKEN!, 'base64').toString('utf8')).toBe('tok-abc-123');
  });
  it('reads the Secret through envFrom and keeps its values out of env', () => {
    const c = container();
    expect(c.envFrom).toEqual([{ secretRef: { name: 'fx2-env' } }]);
    expect(c.env.map((e) => e.name)).not.toContain('DEMO_SECRET');
  });
  it('puts plain env inline in input order', () => {
    expect(container().env).toEqual([
      { name: 'FX_BASE_URL', value: 'https://api.frankfurter.app' },
      { name: 'LOG_LEVEL', value: 'info' },
    ]);
  });
  it('keeps secret values out of the Deployment, Service and NetworkPolicy', () => {
    const m = build();
    const text = JSON.stringify([m.deployment, m.service, m.networkPolicy]);
    expect(text).not.toContain('s3cr3t-xyz');
    expect(text).not.toContain('tok-abc-123');
    expect(text).not.toContain(Buffer.from('s3cr3t-xyz').toString('base64'));
  });
});

describe('service', () => {
  it('maps the port to the port and selects the pod', () => {
    const s = build().service;
    expect(s.spec.type).toBe('ClusterIP');
    expect(s.spec.selector).toEqual({ [HOSTED_LABEL]: 'fx2' });
    expect(s.spec.ports).toEqual([{ name: 'mcp', port: 8080, targetPort: 8080, protocol: 'TCP' }]);
  });
});

describe('network policy', () => {
  const np = () => build().networkPolicy.spec;

  it('selects the hosted pod and restricts both directions', () => {
    expect(np().podSelector).toEqual({ matchLabels: { [HOSTED_LABEL]: 'fx2' } });
    expect([...np().policyTypes].sort()).toEqual(['Egress', 'Ingress']);
  });
  it('admits only the gateway pods of the platform namespace, on the server port', () => {
    expect(np().ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'platform' } },
            podSelector: { matchLabels: config.gatewayLabels },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ]);
  });
  it('never admits a bare pod selector, a bare namespace selector or every source', () => {
    const rule = np().ingress[0];
    expect(rule!.from).toHaveLength(1);
    expect(rule!.from[0]).toHaveProperty('namespaceSelector');
    expect(rule!.from[0]!.podSelector.matchLabels).not.toEqual({});
    expect(rule!.from[0]).not.toHaveProperty('ipBlock');
  });
  it('follows the gateway namespace and labels from the config', () => {
    const m = hostedManifests(spec, secretEnv, {
      ...config,
      gatewayNamespace: 'plat',
      gatewayLabels: { app: 'gw' },
    });
    expect(m.networkPolicy.spec.ingress[0]!.from[0]).toEqual({
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'plat' } },
      podSelector: { matchLabels: { app: 'gw' } },
    });
  });
  it('allows egress only to public addresses on TCP 443', () => {
    expect(np().egress).toEqual([
      {
        to: [
          {
            ipBlock: {
              cidr: '0.0.0.0/0',
              except: [
                '10.0.0.0/8',
                '172.16.0.0/12',
                '192.168.0.0/16',
                '169.254.0.0/16',
                '100.64.0.0/10',
              ],
            },
          },
        ],
        ports: [{ protocol: 'TCP', port: 443 }],
      },
    ]);
  });
});

describe('hostedUrl', () => {
  it('builds the cluster URL', () => {
    expect(hostedUrl('fx2', 8080, '/mcp')).toBe('http://fx2.mcp-hosted.svc.cluster.local:8080/mcp');
  });
});

describe('apply-time guard', () => {
  it.each([
    ['latest', { image: 'fx-mcp:latest' }],
    ['no tag', { image: 'fx-mcp' }],
    ['an image outside the allowlist', { image: 'busybox:1.37' }],
    ['a prefix trick', { image: 'fx-mcp-evil:dev' }],
    ['cpu over the cap', { cpu: '600m' }],
    ['memory over the cap', { memory: '300Mi' }],
    ['no cpu limit', { cpu: '' }],
    ['a privileged port', { port: 80 }],
    ['a bad slug', { slug: 'Fx2' }],
    ['a reserved env name', { env: [{ name: 'MCP_SHARED_TOKEN', value: 'x' }] }],
  ])('refuses a spec with %s even if the row was written around the API', (_why, over) => {
    expect(() => build(over as Partial<HostedSpec>)).toThrow(/invalid hosted spec/);
  });
  it('does not put a secret value in the error', () => {
    let message = '';
    try {
      build({ image: 'busybox:1.37' }, { MCP_SHARED_TOKEN: 'tok-abc-123' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/invalid hosted spec/);
    expect(message).not.toContain('tok-abc-123');
  });
});
