import { describe, expect, it } from 'vitest';
import { nextSecret, parseCreate, parsePatch } from './server-input.js';

const base = {
  name: 'GitHub',
  slug: 'gh',
  url: 'https://api.githubcopilot.com/mcp/',
  auth: { type: 'bearer', secret: 's' },
};
const err = (body: unknown) => {
  const r = parseCreate(body);
  return r.ok ? 'ok' : r.error;
};

describe('parseCreate', () => {
  it('fills the defaults', () => {
    expect(parseCreate(base)).toEqual({
      ok: true,
      value: { ...base, timeoutMs: 15000, protocolMode: 'legacy' },
    });
  });
  it.each([
    ['a', 'invalid_slug'],
    ['ab', 'ok'],
    ['a'.repeat(24), 'ok'],
    ['a'.repeat(25), 'invalid_slug'],
    ['a__b', 'invalid_slug'],
    ['Ab', 'invalid_slug'],
    ['-ab', 'invalid_slug'],
    ['ab-', 'invalid_slug'],
    ['a-b', 'ok'],
  ])('slug %s gives %s', (slug, want) => expect(err({ ...base, slug })).toBe(want));
  it.each([
    ['ftp://x.example/mcp', 'bad_request'],
    ['not a url', 'bad_request'],
    ['file:///etc/passwd', 'bad_request'],
    ['http://fx-mcp.platform.svc.cluster.local:8080/mcp', 'ok'],
    [`https://x.example/${'a'.repeat(2048)}`, 'bad_request'],
  ])('url %s gives %s', (url, want) => expect(err({ ...base, url })).toBe(want));
  it.each([
    [{ type: 'none' }, 'ok'],
    [{ type: 'none', secret: 's' }, 'bad_request'],
    [{ type: 'bearer' }, 'secret_required'],
    [{ type: 'bearer', secret: '' }, 'bad_request'],
    [{ type: 'header', secret: 's' }, 'bad_request'],
    [{ type: 'header', headerName: 'X-Api-Key', secret: 's' }, 'ok'],
    [{ type: 'header', headerName: 'Host', secret: 's' }, 'bad_request'],
    [{ type: 'header', headerName: 'mcp-session-id', secret: 's' }, 'bad_request'],
    [{ type: 'header', headerName: 'bad name', secret: 's' }, 'bad_request'],
    [{ type: 'basic', secret: 's' }, 'bad_request'],
  ])('auth %j gives %s', (auth, want) => expect(err({ ...base, auth })).toBe(want));
  it('refuses fields the API owns', () => {
    for (const extra of [
      { kind: 'system' },
      { managed: true },
      { enabled: false },
      { approval: 'approved' },
    ]) {
      expect(err({ ...base, ...extra })).toBe('bad_request');
    }
  });
  it.each([
    [999, 'bad_request'],
    [1000, 'ok'],
    [60000, 'ok'],
    [60001, 'bad_request'],
    [1500.5, 'bad_request'],
  ])('timeout %d gives %s', (timeoutMs, want) => expect(err({ ...base, timeoutMs })).toBe(want));
  it('takes legacy or auto as protocol mode', () => {
    expect(err({ ...base, protocolMode: 'auto' })).toBe('ok');
    expect(err({ ...base, protocolMode: 'modern' })).toBe('bad_request');
  });
});

describe('parsePatch', () => {
  it('names a slug change', () => {
    expect(parsePatch({ slug: 'new' })).toEqual({ ok: false, error: 'slug_immutable' });
  });
  it('refuses an empty patch and a non-object body', () => {
    expect(parsePatch({})).toEqual({ ok: false, error: 'bad_request' });
    expect(parsePatch(null)).toEqual({ ok: false, error: 'bad_request' });
  });
  it('accepts a partial patch and auth without a secret', () => {
    expect(parsePatch({ enabled: false })).toEqual({ ok: true, value: { enabled: false } });
    expect(parsePatch({ auth: { type: 'bearer' } })).toEqual({
      ok: true,
      value: { auth: { type: 'bearer' } },
    });
  });
});

describe('nextSecret', () => {
  it('keeps, clears or replaces', () => {
    expect(nextSecret(undefined)).toBeUndefined();
    expect(nextSecret({ type: 'none' })).toBeNull();
    expect(nextSecret({ type: 'bearer' })).toBeUndefined();
    expect(nextSecret({ type: 'header', headerName: 'X-K', secret: 'n' })).toBe('n');
  });
});
