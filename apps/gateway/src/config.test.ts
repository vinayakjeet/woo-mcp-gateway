import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const KEK = Buffer.alloc(32, 7).toString('base64');
const full = {
  DATABASE_URL: 'postgres://x@y/z',
  KEK,
  API_KEY_PEPPER: 'p',
  JWT_SIGNING_KEY: 'j',
  GATEWAY_URL: 'http://mcp.test/mcp',
};

describe('loadConfig', () => {
  it('names every missing variable and never a value', () => {
    expect(() => loadConfig({ KEK })).toThrow(
      'Missing env vars: DATABASE_URL, API_KEY_PEPPER, JWT_SIGNING_KEY, GATEWAY_URL',
    );
  });

  it('rejects a KEK that is not 32 bytes without printing it', () => {
    expect(() => loadConfig({ ...full, KEK: 'c2hvcnQ=' })).toThrow('KEK must be 32 bytes');
  });

  it('reads ports, replica and origins with defaults', () => {
    const c = loadConfig({
      ...full,
      POD_NAME: 'gateway-abc',
      ALLOWED_ORIGINS: 'http://a.test, http://b.test,',
    });
    expect(c).toMatchObject({
      replica: 'gateway-abc',
      allowedOrigins: ['http://a.test', 'http://b.test'],
      port: 8080,
      healthPort: 9090,
      audience: 'http://mcp.test/mcp',
    });
    expect(c.kek).toHaveLength(32);
    expect(loadConfig(full).allowedOrigins).toEqual([]);
  });

  it('defaults RATE_LIMIT_PER_MINUTE to 60 and refuses 0, -1 and text', () => {
    expect(loadConfig(full).rateLimitPerMinute).toBe(60);
    expect(loadConfig({ ...full, RATE_LIMIT_PER_MINUTE: '120' }).rateLimitPerMinute).toBe(120);
    for (const bad of ['0', '-1', 'many', '1.5', '']) {
      expect(() => loadConfig({ ...full, RATE_LIMIT_PER_MINUTE: bad })).toThrow(
        'RATE_LIMIT_PER_MINUTE',
      );
    }
  });

  it('keeps http upstreams off unless ALLOW_INSECURE_UPSTREAMS is exactly "true"', () => {
    expect(loadConfig(full).allowInsecureUpstreams).toBe(false);
    expect(loadConfig({ ...full, ALLOW_INSECURE_UPSTREAMS: 'yes' }).allowInsecureUpstreams).toBe(
      false,
    );
    expect(loadConfig({ ...full, ALLOW_INSECURE_UPSTREAMS: 'true' }).allowInsecureUpstreams).toBe(
      true,
    );
  });

  it('OAUTH_ENABLED is true only for the exact string true', () => {
    const issuer = 'https://app.example.test';
    expect(loadConfig(full)).toMatchObject({ oauthEnabled: false, oauthIssuer: null });
    for (const v of ['TRUE', 'True', '1', 'yes', 'false', ' true', '']) {
      expect(loadConfig({ ...full, OAUTH_ENABLED: v, OAUTH_ISSUER: issuer }).oauthEnabled).toBe(
        false,
      );
    }
    expect(loadConfig({ ...full, OAUTH_ENABLED: 'true', OAUTH_ISSUER: issuer })).toMatchObject({
      oauthEnabled: true,
      oauthIssuer: issuer,
    });
  });

  it('OAUTH_ISSUER is required when enabled and must be an origin with no path', () => {
    const on = { ...full, OAUTH_ENABLED: 'true' };
    expect(() => loadConfig(on)).toThrow('OAUTH_ISSUER');
    for (const bad of [
      'https://app.example.test/',
      'https://app.example.test/oauth',
      'https://app.example.test?x=1',
      'https://user:pw@app.example.test',
      'app.example.test',
      'ftp://app.example.test',
    ]) {
      expect(() => loadConfig({ ...on, OAUTH_ISSUER: bad })).toThrow('OAUTH_ISSUER');
    }
    expect(
      loadConfig({ ...on, OAUTH_ISSUER: 'http://app.127.0.0.1.nip.io:8080' }).oauthIssuer,
    ).toBe('http://app.127.0.0.1.nip.io:8080');
  });

  it('never prints a bad OAUTH_ISSUER and ignores it while oauth is off', () => {
    expect(() =>
      loadConfig({ ...full, OAUTH_ENABLED: 'true', OAUTH_ISSUER: 'https://u:secretpw@x.test' }),
    ).toThrow(/^(?!.*secretpw)/s);
    expect(loadConfig({ ...full, OAUTH_ISSUER: 'not a url' }).oauthIssuer).toBeNull();
  });
});
