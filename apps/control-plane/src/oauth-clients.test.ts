import { describe, expect, it } from 'vitest';
import {
  cleanClientName,
  isLoopback,
  redirectMatches,
  validateRedirectUri,
} from './oauth-clients.js';

describe('isLoopback', () => {
  it.each([
    ['http://localhost/cb', true],
    ['http://localhost:53682/cb', true],
    ['http://127.0.0.1:1234/cb', true],
    ['http://[::1]:1234/cb', true],
    ['https://localhost/cb', false],
    ['http://localhost.evil.example/cb', false],
    ['http://127.0.0.1.evil.example/cb', false],
    ['http://127.0.0.2/cb', false],
    ['http://evil.example/localhost', false],
    ['http://0.0.0.0/cb', false],
    ['not a url', false],
  ])('%s is %s', (u, want) => expect(isLoopback(u)).toBe(want));
});

describe('validateRedirectUri', () => {
  it.each([
    'https://client.example/cb',
    'https://client.example/cb?x=1',
    'http://localhost/cb',
    'http://127.0.0.1:8080/cb',
    'http://[::1]/cb',
    'https://bücher.example/cb',
    'https://client.example:8443/cb',
  ])('accepts %s', (u) => expect(validateRedirectUri(u)).toBe(true));

  it.each([
    ['http, not loopback', 'http://client.example/cb'],
    ['http on a lookalike host', 'http://localhost.evil.example/cb'],
    ['fragment', 'https://client.example/cb#frag'],
    ['empty fragment', 'https://client.example/cb#'],
    ['userinfo', 'https://user:pw@client.example/cb'],
    ['username only', 'https://user@client.example/cb'],
    ['custom scheme', 'myapp://callback'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,hi'],
    ['relative', '/cb'],
    ['not a url', 'not a url'],
    ['empty', ''],
    ['newline inside', 'https://client.example/cb\n.evil'],
    ['tab inside', 'https://client.example/\tcb'],
    ['space around', ' https://client.example/cb'],
    ['semicolon in the host', 'https://a;b.example/cb'],
    ['comma in the host', 'https://a,b.example/cb'],
    ['quote in the host', "https://a'b.example/cb"],
    ['underscore in the host', 'https://a_b.example/cb'],
    ['an IPv6 host that is not ::1', 'https://[2001:db8::1]/cb'],
    ['over 2000 characters', `https://client.example/${'a'.repeat(2000)}`],
  ])('refuses %s', (_name, u) => expect(validateRedirectUri(u)).toBe(false));

  it('refuses a non-string', () => {
    for (const v of [undefined, null, 5, {}, ['https://client.example/cb']])
      expect(validateRedirectUri(v)).toBe(false);
  });
});

describe('redirectMatches', () => {
  it('matches an exact https URI', () => {
    expect(redirectMatches(['https://client.example/cb'], 'https://client.example/cb')).toBe(true);
  });
  it('matches any one of several registered URIs', () => {
    const reg = ['https://a.example/cb', 'https://b.example/cb'];
    expect(redirectMatches(reg, 'https://b.example/cb')).toBe(true);
  });
  it.each([
    ['a different path', 'https://client.example/other'],
    ['a different query', 'https://client.example/cb?x=1'],
    ['a trailing slash', 'https://client.example/cb/'],
    ['a different host', 'https://evil.example/cb'],
    ['a subdomain', 'https://x.client.example/cb'],
    ['a different scheme', 'http://client.example/cb'],
    ['a different port on a non-loopback host', 'https://client.example:8443/cb'],
    ['a fragment', 'https://client.example/cb#x'],
    ['userinfo', 'https://u:p@client.example/cb'],
    ['a different case in the path', 'https://client.example/CB'],
    ['an empty string', ''],
  ])('refuses https with %s', (_n, presented) => {
    expect(redirectMatches(['https://client.example/cb'], presented)).toBe(false);
  });

  it.each([
    ['localhost', 'http://localhost/cb', 'http://localhost:1234/cb'],
    ['127.0.0.1', 'http://127.0.0.1/cb', 'http://127.0.0.1:53682/cb'],
    ['[::1]', 'http://[::1]/cb', 'http://[::1]:9/cb'],
    ['a registered port', 'http://localhost:5000/cb', 'http://localhost:6000/cb'],
    ['the same port', 'http://127.0.0.1:5000/cb', 'http://127.0.0.1:5000/cb'],
  ])('ignores the port for loopback %s', (_n, registered, presented) => {
    expect(redirectMatches([registered], presented)).toBe(true);
  });

  it.each([
    ['another path', 'http://localhost:1234/other'],
    ['another query', 'http://localhost:1234/cb?x=1'],
    ['another loopback name', 'http://127.0.0.1:1234/cb'],
    ['https on loopback', 'https://localhost:1234/cb'],
    ['a lookalike host', 'http://localhost.evil.example:1234/cb'],
    ['userinfo', 'http://user@localhost:1234/cb'],
    ['a fragment', 'http://localhost:1234/cb#x'],
    ['a host with the loopback name as userinfo', 'http://localhost:1234@evil.example/cb'],
  ])('still compares scheme, host, path and query for loopback: refuses %s', (_n, presented) => {
    expect(redirectMatches(['http://localhost/cb'], presented)).toBe(false);
  });

  it('does not ignore the port for a registered https URI on localhost', () => {
    expect(redirectMatches(['https://localhost:8443/cb'], 'https://localhost:9443/cb')).toBe(false);
  });
  it('refuses when nothing is registered', () => {
    expect(redirectMatches([], 'https://client.example/cb')).toBe(false);
  });
});

describe('cleanClientName', () => {
  it('defaults when absent or empty after cleaning', () => {
    expect(cleanClientName(undefined)).toBe('Unnamed client');
    expect(cleanClientName('')).toBe('Unnamed client');
    expect(cleanClientName('\n\t‮')).toBe('Unnamed client');
  });
  it('removes control and bidi characters and trims', () => {
    expect(cleanClientName('  My\nApp\u0000‮  ')).toBe('MyApp');
    expect(cleanClientName('A​B')).toBe('AB');
  });
  it('caps at 100 characters without splitting a surrogate pair', () => {
    const name = cleanClientName('x'.repeat(99) + '😀😀');
    expect(Array.from(name)).toHaveLength(100);
    expect(name.endsWith('😀')).toBe(true);
    expect(cleanClientName('y'.repeat(500))).toHaveLength(100);
  });
});
