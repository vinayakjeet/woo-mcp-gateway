import { describe, expect, it } from 'vitest';
import {
  hostedInput,
  hostedRequests,
  loadHostedConfig,
  parseCpu,
  parseHostedInput,
  parseMemory,
  type HostedConfig,
} from './hosted-input.js';

const config: HostedConfig = {
  allowedImagePrefixes: ['fx-mcp:', 'ghcr.io/acme/'],
  maxCpuMillis: 500,
  maxMemoryBytes: 256 * 1024 ** 2,
  gatewayNamespace: 'platform',
  gatewayLabels: { 'app.kubernetes.io/name': 'gateway' },
};
const digest = `sha256:${'a'.repeat(64)}`;

const base = {
  slug: 'fx2',
  image: 'fx-mcp:dev',
  port: 8080,
  cpu: '200m',
  memory: '128Mi',
};
const parse = (over: Record<string, unknown>) =>
  hostedInput(config).safeParse({ ...base, ...over });

describe('image allowlist', () => {
  it.each(['fx-mcp:dev', 'fx-mcp:1.2.3', `ghcr.io/acme/fx@${digest}`, 'ghcr.io/acme/tools/fx:0.1'])(
    'allows %s',
    (image) => {
      expect(parse({ image }).success).toBe(true);
    },
  );

  it.each([
    ['no tag', 'fx-mcp'],
    ['the latest tag', 'fx-mcp:latest'],
    ['latest under another prefix', 'ghcr.io/acme/fx:latest'],
    ['a prefix that is only a string prefix', 'fx-mcp-evil:dev'],
    ['uppercase in the repository', 'FX-MCP:dev'],
    ['an owner that extends the allowed one', 'ghcr.io/acme-evil/x:1'],
    ['a parent path segment', 'ghcr.io/acme/../x:1'],
    ['a leading space', ' fx-mcp:dev'],
    ['a trailing newline', 'fx-mcp:dev\n'],
    ['a registry that is not allowed', 'docker.io/library/busybox:1.37'],
    ['a short digest', 'ghcr.io/acme/fx@sha256:abc'],
    ['a shell metacharacter', 'fx-mcp:dev;id'],
    ['300 characters', `ghcr.io/acme/${'a'.repeat(280)}:1`],
    ['an empty string', ''],
  ])('refuses %s', (_why, image) => {
    expect(parse({ image }).success).toBe(false);
  });

  it('says image_not_allowed for a well formed image outside the allowlist', () => {
    const r = parseHostedInput(config, { ...base, image: 'busybox:1.37' });
    expect(r).toMatchObject({ ok: false, error: 'image_not_allowed' });
  });

  it('says invalid_hosted for a malformed image', () => {
    const r = parseHostedInput(config, { ...base, image: 'fx-mcp:latest' });
    expect(r).toMatchObject({ ok: false, error: 'invalid_hosted' });
  });

  it('refuses everything when no prefix is configured', () => {
    const none = { ...config, allowedImagePrefixes: [] };
    expect(parseHostedInput(none, base)).toMatchObject({ ok: false, error: 'image_not_allowed' });
  });
});

describe('port and path', () => {
  it.each([80, 1023, 70000, 8080.5, '8080'])('refuses port %s', (port) => {
    expect(parse({ port }).success).toBe(false);
  });
  it.each([1024, 8080, 65535])('allows port %s', (port) => {
    expect(parse({ port }).success).toBe(true);
  });
  it.each(['mcp', '/a b', '/a?x=1', '/../x', '/a/../b', `/${'a'.repeat(200)}`])(
    'refuses path %s',
    (path) => {
      expect(parse({ path }).success).toBe(false);
    },
  );
  it('defaults the path to /mcp', () => {
    const r = parse({});
    expect(r.success && r.data.path).toBe('/mcp');
  });
  it('keeps a given path', () => {
    const r = parse({ path: '/v1/mcp' });
    expect(r.success && r.data.path).toBe('/v1/mcp');
  });
});

describe('slug', () => {
  it.each(['fx__2', 'a', 'Fx2', 'fx_2', '2fx', 'fx-'])('refuses %s', (slug) => {
    expect(parse({ slug }).success).toBe(false);
  });
  it('allows fx2', () => {
    expect(parse({ slug: 'fx2' }).success).toBe(true);
  });
});

describe('env', () => {
  it.each(['1A', 'a-b', 'KUBERNETES_SERVICE_HOST', 'MCP_SHARED_TOKEN', 'A'.repeat(65), ''])(
    'refuses the plain env name %s',
    (name) => {
      expect(parse({ env: [{ name, value: 'x' }] }).success).toBe(false);
    },
  );
  it('refuses the reserved token name as a secret env name too', () => {
    expect(parse({ secretEnv: [{ name: 'MCP_SHARED_TOKEN', value: 'x' }] }).success).toBe(false);
  });
  it('refuses a name that is in both lists', () => {
    const r = parse({
      env: [{ name: 'MODE', value: 'a' }],
      secretEnv: [{ name: 'MODE', value: 'b' }],
    });
    expect(r.success).toBe(false);
  });
  it('refuses a duplicate name inside one list', () => {
    const r = parse({
      env: [
        { name: 'MODE', value: 'a' },
        { name: 'MODE', value: 'b' },
      ],
    });
    expect(r.success).toBe(false);
  });
  it('refuses 33 plain entries and allows 32', () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `V${i}`, value: 'x' }));
    expect(parse({ env: rows(33) }).success).toBe(false);
    expect(parse({ env: rows(32) }).success).toBe(true);
  });
  it('refuses 17 secret entries and allows 16', () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `S${i}`, value: 'x' }));
    expect(parse({ secretEnv: rows(17) }).success).toBe(false);
    expect(parse({ secretEnv: rows(16) }).success).toBe(true);
  });
  it('refuses a value over 4096 characters', () => {
    expect(parse({ env: [{ name: 'A', value: 'x'.repeat(4097) }] }).success).toBe(false);
    expect(parse({ env: [{ name: 'A', value: 'x'.repeat(4096) }] }).success).toBe(true);
  });
  it('refuses an empty secret value and a NUL byte', () => {
    expect(parse({ secretEnv: [{ name: 'A', value: '' }] }).success).toBe(false);
    expect(parse({ env: [{ name: 'A', value: 'a\u0000b' }] }).success).toBe(false);
  });
  it('defaults both lists to empty and keeps order', () => {
    const r = parse({
      env: [
        { name: 'B', value: '1' },
        { name: 'A', value: '2' },
      ],
    });
    expect(r.success && r.data.env.map((e) => e.name)).toEqual(['B', 'A']);
    expect(r.success && r.data.secretEnv).toEqual([]);
  });
});

describe('limits', () => {
  it.each(['600m', '1', '0', '0m', '-1', '1.5', '2000m', 'abc', '', '0.0001', '200 m'])(
    'refuses cpu %s',
    (cpu) => {
      expect(parse({ cpu }).success).toBe(false);
    },
  );
  it.each(['0.2', '250m', '500m', '0.5', '20m'])('allows cpu %s', (cpu) => {
    expect(parse({ cpu }).success).toBe(true);
  });
  it.each(['300Mi', '0', '257Mi', '1Gi', '1G', '268435457', '64Mx', ''])(
    'refuses memory %s',
    (memory) => {
      expect(parse({ memory }).success).toBe(false);
    },
  );
  it.each(['128Mi', '134217728', '256Mi', '64M'])('allows memory %s', (memory) => {
    expect(parse({ memory }).success).toBe(true);
  });
  it('keeps the quantity strings as submitted', () => {
    const r = parse({ cpu: '0.2', memory: '134217728' });
    expect(r.success && [r.data.cpu, r.data.memory]).toEqual(['0.2', '134217728']);
  });
  it('requires both limits', () => {
    const noCpu: Record<string, unknown> = { ...base };
    delete noCpu.cpu;
    const noMemory: Record<string, unknown> = { ...base };
    delete noMemory.memory;
    expect(hostedInput(config).safeParse(noCpu).success).toBe(false);
    expect(hostedInput(config).safeParse(noMemory).success).toBe(false);
  });
});

describe('parseCpu and parseMemory', () => {
  it('reads cpu as millicores', () => {
    expect(parseCpu('0.2')).toBe(200);
    expect(parseCpu('250m')).toBe(250);
    expect(parseCpu('1')).toBe(1000);
    expect(parseCpu('0.001')).toBe(1);
    expect(parseCpu('abc')).toBeNull();
    expect(parseCpu('1.5m')).toBeNull();
  });
  it('reads memory as bytes and tells G from Gi', () => {
    expect(parseMemory('128Mi')).toBe(128 * 1024 ** 2);
    expect(parseMemory('134217728')).toBe(134217728);
    expect(parseMemory('1G')).toBe(1_000_000_000);
    expect(parseMemory('1Gi')).toBe(1024 ** 3);
    expect(parseMemory('1G')).not.toBe(parseMemory('1Gi'));
    expect(parseMemory('64M')).toBe(64_000_000);
    expect(parseMemory('1Xi')).toBeNull();
    expect(parseMemory('')).toBeNull();
  });
});

describe('hostedRequests', () => {
  it('fixes requests at 20m and 64Mi', () => {
    expect(hostedRequests({ cpu: '200m', memory: '128Mi' })).toEqual({
      cpu: '20m',
      memory: '64Mi',
    });
  });
  it('lowers a request to a smaller limit', () => {
    expect(hostedRequests({ cpu: '10m', memory: '32Mi' })).toEqual({ cpu: '10m', memory: '32Mi' });
  });
  it('lowers per resource', () => {
    expect(hostedRequests({ cpu: '10m', memory: '128Mi' })).toEqual({ cpu: '10m', memory: '64Mi' });
  });
  it('never exceeds the limit for a fractional cpu', () => {
    expect(hostedRequests({ cpu: '0.01', memory: '64Mi' })).toEqual({
      cpu: '0.01',
      memory: '64Mi',
    });
  });
});

describe('messages', () => {
  it('never contain a submitted value', () => {
    const r = parseHostedInput(config, {
      ...base,
      secretEnv: [{ name: 'bad name', value: 's3cr3t-xyz' }],
      env: [{ name: 'OK', value: 'plain-val-123', extra: 'leak-in-key' }],
      'leak-top-key': 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = JSON.stringify(r.issues);
    for (const v of ['s3cr3t-xyz', 'plain-val-123', 'leak-in-key', 'leak-top-key', 'bad name']) {
      expect(text).not.toContain(v);
    }
    expect(r.issues.length).toBeGreaterThan(0);
  });
  it('names the field by path', () => {
    const r = parseHostedInput(config, { ...base, port: 80 });
    expect(r).toMatchObject({ ok: false, issues: [{ path: 'port' }] });
  });
  it('does not echo an oversized secret value', () => {
    const r = parseHostedInput(config, {
      ...base,
      secretEnv: [{ name: 'A', value: `SECRETMARK${'x'.repeat(5000)}` }],
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('SECRETMARK');
  });
  it('refuses a body that is not an object', () => {
    expect(parseHostedInput(config, null)).toMatchObject({ ok: false, error: 'invalid_hosted' });
    expect(parseHostedInput(config, 'x')).toMatchObject({ ok: false, error: 'invalid_hosted' });
  });
});

describe('loadHostedConfig', () => {
  const env = (over: Record<string, string>): NodeJS.ProcessEnv => ({ ...over });

  it('defaults to no prefixes and the plan caps', () => {
    const c = loadHostedConfig(env({}));
    expect(c.allowedImagePrefixes).toEqual([]);
    expect(c.maxCpuMillis).toBe(500);
    expect(c.maxMemoryBytes).toBe(256 * 1024 ** 2);
    expect(c.gatewayNamespace).toBe('platform');
  });
  it('reads the chart env', () => {
    const c = loadHostedConfig(
      env({
        HOSTED_ALLOWED_IMAGE_PREFIXES: '["fx-mcp:","ghcr.io/acme/"]',
        HOSTED_MAX_CPU: '1',
        HOSTED_MAX_MEMORY: '512Mi',
        HOSTED_GATEWAY_NAMESPACE: 'plat',
        HOSTED_GATEWAY_LABELS:
          '{"app.kubernetes.io/name":"gateway","app.kubernetes.io/instance":"p"}',
      }),
    );
    expect(c).toEqual({
      allowedImagePrefixes: ['fx-mcp:', 'ghcr.io/acme/'],
      maxCpuMillis: 1000,
      maxMemoryBytes: 512 * 1024 ** 2,
      gatewayNamespace: 'plat',
      gatewayLabels: { 'app.kubernetes.io/name': 'gateway', 'app.kubernetes.io/instance': 'p' },
    });
  });
  it.each(['ghcr.io/acme', 'fx-mcp', 'ghcr.io/', '', ':'])(
    'throws on the prefix "%s"',
    (prefix) => {
      expect(() =>
        loadHostedConfig(env({ HOSTED_ALLOWED_IMAGE_PREFIXES: JSON.stringify([prefix]) })),
      ).toThrow(/prefix/i);
    },
  );
  it('throws on a prefix list that is not a JSON array of strings', () => {
    expect(() => loadHostedConfig(env({ HOSTED_ALLOWED_IMAGE_PREFIXES: 'fx-mcp:' }))).toThrow();
    expect(() => loadHostedConfig(env({ HOSTED_ALLOWED_IMAGE_PREFIXES: '[1]' }))).toThrow();
  });
  it('throws on a cap that is not a quantity or is zero', () => {
    expect(() => loadHostedConfig(env({ HOSTED_MAX_CPU: 'lots' }))).toThrow(/HOSTED_MAX_CPU/);
    expect(() => loadHostedConfig(env({ HOSTED_MAX_MEMORY: '0' }))).toThrow(/HOSTED_MAX_MEMORY/);
  });
  it('throws on gateway labels that are not a string map', () => {
    expect(() => loadHostedConfig(env({ HOSTED_GATEWAY_LABELS: '{"a":1}' }))).toThrow();
    expect(() => loadHostedConfig(env({ HOSTED_GATEWAY_LABELS: '{}' }))).toThrow();
  });
});
