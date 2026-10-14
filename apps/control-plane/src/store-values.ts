import { z } from 'zod';

const defaults = z.object({
  global: z.object({
    domain: z.string().min(1),
    scheme: z.enum(['http', 'https']),
    imageTag: z
      .string()
      .min(1)
      .refine((t) => t !== 'latest', 'must be a pinned tag'),
  }),
  images: z.object({ registry: z.string() }),
  ingress: z.object({
    className: z.string().min(1),
    tls: z.object({ enabled: z.boolean(), clusterIssuer: z.string() }),
  }),
  storage: z.object({
    className: z.string().min(1),
    mariadb: z.string().min(1),
    wordpress: z.string().min(1),
  }),
  wordpress: z.object({ environmentType: z.enum(['local', 'production']) }),
});

export type StoreDefaults = z.infer<typeof defaults>;
export type ProvisionerConfig = { storeDefaults: StoreDefaults; maxStoresPerUser: number };

export function parseStoreDefaults(json: string): StoreDefaults {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('PROVISIONER_STORE_VALUES invalid: not JSON');
  }
  const p = defaults.safeParse(raw);
  if (!p.success) {
    const issues = p.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`PROVISIONER_STORE_VALUES invalid: ${issues.join('; ')}`);
  }
  return p.data;
}

export function provisionerConfig(env: NodeJS.ProcessEnv): ProvisionerConfig | null {
  if (env.PROVISIONER_ENABLED !== 'true') return null;
  const json = env.PROVISIONER_STORE_VALUES;
  if (!json) throw new Error('Missing env vars: PROVISIONER_STORE_VALUES');
  const max = Number(env.PROVISIONER_MAX_STORES_PER_USER ?? '3');
  if (!Number.isInteger(max) || max < 1) {
    throw new Error('PROVISIONER_MAX_STORES_PER_USER must be a positive integer');
  }
  return { storeDefaults: parseStoreDefaults(json), maxStoresPerUser: max };
}

export const storeNamespace = (slug: string): string => `store-${slug}`;

export const storeUrl = (d: StoreDefaults, slug: string): string =>
  `${d.global.scheme}://${slug}.shop.${d.global.domain}`;

// Same form as the seeded main store, so the gateway treats both alike.
export const storeMcpUrl = (slug: string): string =>
  `http://woo-mcp.store-${slug}.svc.cluster.local:8080/mcp`;

// SPEC 15. Enforce refuses pods that break restricted; warn also makes helm print violations in
// pod templates, such as the bootstrap Job, which enforce only sees when its pod is created.
export function storeLabels(slug: string): Record<string, string> {
  return {
    'urumi.io/store': slug,
    'urumi.io/managed': 'true',
    'pod-security.kubernetes.io/enforce': 'restricted',
    'pod-security.kubernetes.io/warn': 'restricted',
  };
}

// SPEC 18 generated values. JSON is valid YAML, so a store name needs no YAML quoting.
export function storeValues(
  d: StoreDefaults,
  s: { slug: string; name: string },
  token: string,
): string {
  return JSON.stringify({ ...d, slug: s.slug, storeName: s.name, mcp: { sharedToken: token } });
}
