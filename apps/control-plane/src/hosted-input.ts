import { isValidSlug } from '@woo/core';
import { z } from 'zod';

export type HostedConfig = {
  allowedImagePrefixes: string[];
  maxCpuMillis: number;
  maxMemoryBytes: number;
  gatewayNamespace: string;
  gatewayLabels: Record<string, string>;
};

export const IMAGE_NOT_ALLOWED = 'Image is not under an allowed prefix';
// Reserved because the control-plane generates the gateway token and injects it under this name.
export const RESERVED_ENV = 'MCP_SHARED_TOKEN';

const MAX_ENV = 32;
const MAX_SECRET_ENV = 16;
const MAX_VALUE = 4096;
const REQUEST_CPU_MILLIS = 20;
const REQUEST_MEMORY_BYTES = 64 * 1024 ** 2;

const MEMORY_UNITS: Record<string, number> = {
  '': 1,
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

const CPU_RE = /^(?:(\d{1,6})m|(\d{1,3})(?:\.(\d{1,3}))?)$/;
const MEMORY_RE = /^(\d{1,12})(?:\.(\d{1,3}))?(Ki|Mi|Gi|Ti|k|M|G|T)?$/;

// Kubernetes quantity to millicores. Null for anything else, including more than 3 decimals.
export function parseCpu(q: string): number | null {
  const m = CPU_RE.exec(q);
  if (!m) return null;
  if (m[1] !== undefined) return Number(m[1]);
  return Number(m[2]) * 1000 + Number((m[3] ?? '').padEnd(3, '0'));
}

// Kubernetes quantity to bytes, rounded up like Kubernetes does. G is 10^9 and Gi is 2^30.
export function parseMemory(q: string): number | null {
  const m = MEMORY_RE.exec(q);
  if (!m) return null;
  return Math.ceil(Number(`${m[1]}.${m[2] ?? '0'}`) * MEMORY_UNITS[m[3] ?? '']!);
}

// Requests are fixed at fx-mcp's own values and lowered to the limit when the limit is smaller,
// because a request above its limit is rejected by the API server.
export function hostedRequests(limits: { cpu: string; memory: string }): {
  cpu: string;
  memory: string;
} {
  const cpu = parseCpu(limits.cpu);
  const memory = parseMemory(limits.memory);
  if (cpu === null || memory === null) throw new Error('hostedRequests needs validated limits');
  return {
    cpu: cpu < REQUEST_CPU_MILLIS ? limits.cpu : `${REQUEST_CPU_MILLIS}m`,
    memory: memory < REQUEST_MEMORY_BYTES ? limits.memory : '64Mi',
  };
}

const NAME_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const HOST = '[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?';
const TAG = '[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}';
const IMAGE_RE = new RegExp(
  `^(?:${HOST}/)?${NAME_COMPONENT}(?:/${NAME_COMPONENT})*(?::(${TAG})|@sha256:[a-f0-9]{64})$`,
);

const PREFIX_RE = /^[a-z0-9][a-z0-9._/:-]*[/:]$/;

// A prefix ends in "/" or ":" so "ghcr.io/acme/" cannot admit "ghcr.io/acme-evil/x:1" and "fx-mcp:"
// cannot admit "fx-mcp-evil:1". A bare registry would admit every image on it.
function checkPrefix(p: unknown): string {
  const ok =
    typeof p === 'string' &&
    PREFIX_RE.test(p) &&
    !(p.endsWith('/') && !p.slice(0, -1).includes('/') && /[.:]/.test(p));
  if (!ok) {
    throw new Error(
      `HOSTED_ALLOWED_IMAGE_PREFIXES: prefix ${JSON.stringify(p)} must be lowercase, end with "/" or ":" and name more than a registry`,
    );
  }
  return p;
}

function quantityEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
  parse: typeof parseCpu,
) {
  const n = parse(env[name] ?? fallback);
  if (n === null || n <= 0) throw new Error(`${name} must be a positive Kubernetes quantity`);
  return n;
}

function jsonEnv(env: NodeJS.ProcessEnv, name: string, fallback: string): unknown {
  try {
    return JSON.parse(env[name] ?? fallback);
  } catch {
    throw new Error(`${name} must be JSON`);
  }
}

export function loadHostedConfig(env: NodeJS.ProcessEnv): HostedConfig {
  const prefixes = jsonEnv(env, 'HOSTED_ALLOWED_IMAGE_PREFIXES', '[]');
  if (!Array.isArray(prefixes)) {
    throw new Error('HOSTED_ALLOWED_IMAGE_PREFIXES must be a JSON array of strings');
  }
  const labels = z
    .record(z.string(), z.string())
    .refine((l) => Object.keys(l).length > 0)
    .safeParse(jsonEnv(env, 'HOSTED_GATEWAY_LABELS', '{"app.kubernetes.io/name":"gateway"}'));
  if (!labels.success) {
    throw new Error('HOSTED_GATEWAY_LABELS must be a non-empty JSON object of strings');
  }
  return {
    allowedImagePrefixes: prefixes.map(checkPrefix),
    maxCpuMillis: quantityEnv(env, 'HOSTED_MAX_CPU', '500m', parseCpu),
    maxMemoryBytes: quantityEnv(env, 'HOSTED_MAX_MEMORY', '256Mi', parseMemory),
    gatewayNamespace: env.HOSTED_GATEWAY_NAMESPACE || 'platform',
    gatewayLabels: labels.data,
  };
}

const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, { error: 'Invalid env name' })
  .refine((n) => !n.startsWith('KUBERNETES_'), {
    error: 'Env names must not start with KUBERNETES_',
  })
  .refine((n) => n !== RESERVED_ENV, { error: `${RESERVED_ENV} is reserved` });
const noNul = (v: string) => !v.includes('\u0000');
const plainValue = z.string().max(MAX_VALUE).refine(noNul, { error: 'Invalid value' });
const secretValue = z.string().min(1).max(MAX_VALUE).refine(noNul, { error: 'Invalid value' });

export function hostedInput(config: HostedConfig) {
  const image = z
    .string()
    .max(255)
    .superRefine((v, ctx) => {
      const m = IMAGE_RE.exec(v);
      if (!m) {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid image reference, use name:tag or name@sha256:digest',
        });
      } else if (m[1] === 'latest') {
        ctx.addIssue({ code: 'custom', message: 'The latest tag is not allowed' });
      } else if (!config.allowedImagePrefixes.some((p) => v.startsWith(p))) {
        ctx.addIssue({ code: 'custom', message: IMAGE_NOT_ALLOWED });
      }
    });

  const cpu = z.string().superRefine((v, ctx) => {
    const n = parseCpu(v);
    if (n === null || n <= 0) ctx.addIssue({ code: 'custom', message: 'Invalid CPU quantity' });
    else if (n > config.maxCpuMillis)
      ctx.addIssue({ code: 'custom', message: 'CPU is over the cap' });
  });
  const memory = z.string().superRefine((v, ctx) => {
    const n = parseMemory(v);
    if (n === null || n <= 0) ctx.addIssue({ code: 'custom', message: 'Invalid memory quantity' });
    else if (n > config.maxMemoryBytes) {
      ctx.addIssue({ code: 'custom', message: 'Memory is over the cap' });
    }
  });

  return z
    .object({
      slug: z.string().refine(isValidSlug, { error: 'Invalid slug' }),
      image,
      port: z.number().int().min(1024).max(65535),
      path: z
        .string()
        .regex(/^\/[A-Za-z0-9._~/-]{0,199}$/, { error: 'Invalid path' })
        .refine((p) => !p.split('/').includes('..'), { error: 'Invalid path' })
        .default('/mcp'),
      env: z
        .array(z.object({ name: envName, value: plainValue }).strict())
        .max(MAX_ENV)
        .default([]),
      secretEnv: z
        .array(z.object({ name: envName, value: secretValue }).strict())
        .max(MAX_SECRET_ENV)
        .default([]),
      cpu,
      memory,
    })
    .strict()
    .superRefine((v, ctx) => {
      const seen = new Set<string>();
      for (const key of ['env', 'secretEnv'] as const) {
        v[key].forEach((e, i) => {
          if (seen.has(e.name)) {
            ctx.addIssue({ code: 'custom', path: [key, i, 'name'], message: 'Duplicate env name' });
          }
          seen.add(e.name);
        });
      }
    });
}

export type HostedInput = z.infer<ReturnType<typeof hostedInput>>;
export type HostedIssue = { path: string; message: string };

// Zod's own text for unknown keys names them, and a key can be anything a client sends. Every
// other message is fixed text, so an issue never carries a submitted value.
function safeIssues(issues: z.core.$ZodIssue[]): HostedIssue[] {
  return issues.map((i) => ({
    path: i.path.join('.'),
    message: i.code === 'unrecognized_keys' ? 'Unknown field' : i.message,
  }));
}

export function parseHostedInput(
  config: HostedConfig,
  body: unknown,
):
  | { ok: true; value: HostedInput }
  | { ok: false; error: 'invalid_hosted' | 'image_not_allowed'; issues: HostedIssue[] } {
  const p = hostedInput(config).safeParse(body);
  if (p.success) return { ok: true, value: p.data };
  const issues = safeIssues(p.error.issues);
  const notAllowed = issues.some((i) => i.path === 'image' && i.message === IMAGE_NOT_ALLOWED);
  return { ok: false, error: notAllowed ? 'image_not_allowed' : 'invalid_hosted', issues };
}
