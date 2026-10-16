import { describe, expect, it } from 'vitest';
import { oauthNext } from './login-next';

const authorize =
  '/oauth/authorize?client_id=dcr_abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcb&state=s';

describe('oauthNext', () => {
  it('follows an authorize path with its query', () => {
    expect(oauthNext(authorize)).toBe(authorize);
  });
  it.each([
    ['nothing', null],
    ['an empty string', ''],
    ['a protocol-relative URL', '//evil.example/oauth/authorize?x=1'],
    ['an absolute URL', 'https://evil.example/oauth/authorize?x=1'],
    [
      'an absolute URL to our own path on another host',
      'https://evil.example/?next=/oauth/authorize?x=1',
    ],
    ['another page of ours', '/keys'],
    ['the root', '/'],
    ['authorize without a query', '/oauth/authorize'],
    ['a longer path name', '/oauth/authorizex?x=1'],
    ['a sub path', '/oauth/authorize/extra?x=1'],
    ['a path that climbs out', '/oauth/authorize/../../api/keys?x=1'],
    ['a leading space', ' /oauth/authorize?x=1'],
    ['a backslash prefix', '\\oauth\\authorize?x=1'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a value over 4000 characters', `/oauth/authorize?${'a'.repeat(4000)}`],
  ])('refuses %s', (_name, next) => {
    expect(oauthNext(next)).toBeNull();
  });
});
