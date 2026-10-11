import { describe, expect, it } from 'vitest';
import { parseSeedServers } from './seed.js';

const base = {
  slug: 'main',
  name: 'Main Store',
  url: 'http://woo-mcp:8080/mcp',
  kind: 'store',
  managed: true,
};

describe('parseSeedServers', () => {
  it('accepts bearer, header and none auth', () => {
    const list = parseSeedServers(
      JSON.stringify([
        { ...base, auth: { type: 'bearer', secret: 's3cr3t' } },
        {
          ...base,
          slug: 'fx',
          kind: 'system',
          auth: { type: 'header', headerName: 'X-Key', secret: 's3cr3t' },
        },
        { ...base, slug: 'open', kind: 'external', auth: { type: 'none' } },
      ]),
    );
    expect(list.map((s) => s.slug)).toEqual(['main', 'fx', 'open']);
  });
  it('requires a secret for bearer and a header name for header', () => {
    expect(() => parseSeedServers(JSON.stringify([{ ...base, auth: { type: 'bearer' } }]))).toThrow(
      /auth/,
    );
    expect(() =>
      parseSeedServers(JSON.stringify([{ ...base, auth: { type: 'header', secret: 'x' } }])),
    ).toThrow(/auth/);
  });
  it('rejects an invalid slug and a non-array', () => {
    expect(() =>
      parseSeedServers(JSON.stringify([{ ...base, slug: 'Main', auth: { type: 'none' } }])),
    ).toThrow(/slug/);
    expect(() => parseSeedServers('{}')).toThrow(/SEED_SERVERS/);
    expect(() => parseSeedServers('not json')).toThrow(/SEED_SERVERS/);
  });
  it('never puts the secret value in an error', () => {
    let msg = '';
    try {
      parseSeedServers(
        JSON.stringify([
          { ...base, slug: 'Bad', url: 'nope', auth: { type: 'bearer', secret: 's3cr3t' } },
        ]),
      );
    } catch (err) {
      msg = String(err);
    }
    expect(msg).not.toBe('');
    expect(msg).not.toContain('s3cr3t');
  });
});
