import { createHmac, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_S,
  ACCESS_TOKEN_TYP,
  OAuthJwtError,
  oauthKeys,
  oauthSubKey,
  parseOAuthIssuer,
  OAUTH_CSRF_INFO,
  signAccessToken,
  verifyAccessToken,
} from './oauth-jwt.js';

const secret = 's'.repeat(64);
const keys = oauthKeys(secret);
const iss = 'https://app.example.test';
const aud = 'https://mcp.example.test/mcp';
const sub = '0b2f8f0e-7d0c-4a52-9a43-3c5a0a1d7e11';
const now = 1_800_000_000;
const o = { publicKey: keys.publicKey, kid: keys.kid, iss, aud, now };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const claims = {
  iss,
  aud,
  sub,
  client_id: 'dcr_abc',
  scope: 'mcp:tools',
  iat: now,
  exp: now + 900,
  jti: 'j1',
};
const hdr = { alg: 'EdDSA', typ: ACCESS_TOKEN_TYP, kid: keys.kid };
const without = (o: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

// Signs with the real key so a test reaches the check it names, not the signature check.
const forge = (header: object, c: object) => {
  const body = `${b64(header)}.${b64(c)}`;
  return `${body}.${sign(null, Buffer.from(body), keys.privateKey).toString('base64url')}`;
};
const good = () =>
  signAccessToken({ keys, iss, aud, sub, clientId: 'dcr_abc', scope: 'mcp:tools', now });

describe('oauth keys', () => {
  it('the same JWT_SIGNING_KEY gives the same key pair and kid; another key gives another', () => {
    const again = oauthKeys(secret);
    expect(again.kid).toBe(keys.kid);
    expect(again.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(again.publicKey.export({ format: 'der', type: 'spki' })).toEqual(
      keys.publicKey.export({ format: 'der', type: 'spki' }),
    );
    expect(oauthKeys('t'.repeat(64)).kid).not.toBe(keys.kid);
  });
  it('derives a distinct key per info label', () => {
    const a = oauthSubKey(secret, OAUTH_CSRF_INFO);
    expect(a).toHaveLength(32);
    expect(oauthSubKey(secret, OAUTH_CSRF_INFO)).toEqual(a);
    expect(oauthSubKey(secret, 'urumi oauth other v1')).not.toEqual(a);
    expect(oauthSubKey('t'.repeat(64), OAUTH_CSRF_INFO)).not.toEqual(a);
    const seed = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
    expect(seed).not.toEqual(a);
  });
});

describe('access token', () => {
  it('signs a token that verifies and returns the claims', () => {
    const t = good();
    const header = JSON.parse(Buffer.from(t.split('.')[0]!, 'base64url').toString());
    expect(header).toEqual(hdr);
    const c = verifyAccessToken(t, o);
    expect(c).toMatchObject({
      iss,
      aud,
      sub,
      client_id: 'dcr_abc',
      scope: 'mcp:tools',
      iat: now,
      exp: now + ACCESS_TOKEN_TTL_S,
    });
    expect(typeof c.jti).toBe('string');
  });
  it('signAccessToken refuses a ttl over 900 and a ttl of 0', () => {
    const a = { keys, iss, aud, sub, clientId: 'c', scope: 'mcp:tools', now };
    expect(() => signAccessToken({ ...a, ttlSeconds: 901 })).toThrow(OAuthJwtError);
    expect(() => signAccessToken({ ...a, ttlSeconds: 0 })).toThrow(OAuthJwtError);
    expect(() => signAccessToken({ ...a, ttlSeconds: 900 })).not.toThrow();
  });

  it('refuses alg none, HS256 signed with the public key bytes, RS256, ES256 and lowercase eddsa', () => {
    const pubBytes = keys.publicKey.export({ format: 'der', type: 'spki' });
    const hs = (() => {
      const h = { alg: 'HS256', typ: ACCESS_TOKEN_TYP, kid: keys.kid };
      const body = `${b64(h)}.${b64(claims)}`;
      return `${body}.${createHmac('sha256', pubBytes).update(body).digest('base64url')}`;
    })();
    // Signed with the real key: only the alg check can refuse these.
    const withAlg = (alg: string) => forge({ ...hdr, alg }, claims);
    const unsigned = `${b64({ ...hdr, alg: 'none' })}.${b64(claims)}.`;
    for (const t of [
      hs,
      unsigned,
      withAlg('none'),
      withAlg('HS256'),
      withAlg('RS256'),
      withAlg('ES256'),
      withAlg('eddsa'),
      withAlg(''),
    ])
      expect(() => verifyAccessToken(t, o)).toThrow(OAuthJwtError);
  });
  it('refuses a missing or wrong kid and a crit header', () => {
    expect(() => verifyAccessToken(forge(without(hdr, 'kid'), claims), o)).toThrow(OAuthJwtError);
    expect(() => verifyAccessToken(forge({ ...hdr, kid: 'ffffffffffffffff' }, claims), o)).toThrow(
      OAuthJwtError,
    );
    expect(() => verifyAccessToken(forge({ ...hdr, crit: ['exp'] }, claims), o)).toThrow(
      OAuthJwtError,
    );
  });
  it('refuses typ agent+jwt, typ JWT and no typ', () => {
    for (const h of [{ ...hdr, typ: 'agent+jwt' }, { ...hdr, typ: 'JWT' }, without(hdr, 'typ')])
      expect(() => verifyAccessToken(forge(h, claims), o)).toThrow(OAuthJwtError);
  });

  it('refuses a wrong iss, a wrong aud and an aud array', () => {
    for (const c of [
      { ...claims, iss: 'https://app.evil.test' },
      { ...claims, iss: `${iss}/` },
      { ...claims, aud: 'https://mcp.example.test/other' },
      { ...claims, aud: [aud] },
      { ...claims, aud: [aud, 'https://other.test'] },
      { ...claims, aud: undefined },
    ])
      expect(() => verifyAccessToken(forge(hdr, c), o)).toThrow(OAuthJwtError);
    expect(() => verifyAccessToken(good(), { ...o, aud: 'https://mcp.other.test/mcp' })).toThrow(
      OAuthJwtError,
    );
    expect(() => verifyAccessToken(good(), { ...o, iss: 'https://app.other.test' })).toThrow(
      OAuthJwtError,
    );
  });

  it('refuses an expired token and accepts one 29 s past exp', () => {
    const t = good();
    expect(verifyAccessToken(t, { ...o, now: now + 900 + 29 }).sub).toBe(sub);
    expect(() => verifyAccessToken(t, { ...o, now: now + 900 + 30 })).toThrow(OAuthJwtError);
    expect(() => verifyAccessToken(t, { ...o, now: now + 3600 })).toThrow(OAuthJwtError);
  });
  it('refuses a token issued in the future beyond the skew', () => {
    const t = good();
    expect(verifyAccessToken(t, { ...o, now: now - 29 }).sub).toBe(sub);
    expect(() => verifyAccessToken(t, { ...o, now: now - 31 })).toThrow(OAuthJwtError);
  });
  it('refuses a token whose exp - iat exceeds 900, and exp not after iat', () => {
    expect(() => verifyAccessToken(forge(hdr, { ...claims, exp: now + 901 }), o)).toThrow(
      OAuthJwtError,
    );
    expect(() => verifyAccessToken(forge(hdr, { ...claims, exp: now }), o)).toThrow(OAuthJwtError);
    expect(() => verifyAccessToken(forge(hdr, { ...claims, exp: 'soon' }), o)).toThrow(
      OAuthJwtError,
    );
  });

  it('refuses a scope without mcp:tools and accepts one that lists it among others', () => {
    for (const scope of ['', 'mcp:toolsX', 'other', 'mcp:tool', undefined, 7])
      expect(() => verifyAccessToken(forge(hdr, { ...claims, scope }), o)).toThrow(OAuthJwtError);
    expect(verifyAccessToken(forge(hdr, { ...claims, scope: 'a mcp:tools' }), o).sub).toBe(sub);
  });
  it('refuses a sub that is not a UUID and a missing client_id or jti', () => {
    for (const c of [
      { ...claims, sub: 'u1' },
      { ...claims, sub: '' },
      { ...claims, sub: 7 },
      { ...claims, client_id: undefined },
      { ...claims, client_id: '' },
      { ...claims, jti: undefined },
    ])
      expect(() => verifyAccessToken(forge(hdr, c), o)).toThrow(OAuthJwtError);
  });

  it('refuses a flipped signature bit, a changed payload and a token from another key', () => {
    const [h, p, s] = good().split('.') as [string, string, string];
    const sig = Buffer.from(s, 'base64url');
    sig[10] = sig[10]! ^ 1;
    expect(() => verifyAccessToken(`${h}.${p}.${sig.toString('base64url')}`, o)).toThrow(
      OAuthJwtError,
    );
    const changed = b64({ ...claims, sub: '11111111-1111-4111-8111-111111111111' });
    expect(() => verifyAccessToken(`${h}.${changed}.${s}`, o)).toThrow(OAuthJwtError);
    const foreign = oauthKeys('t'.repeat(64));
    const t = signAccessToken({
      keys: foreign,
      iss,
      aud,
      sub,
      clientId: 'c',
      scope: 'mcp:tools',
      now,
    });
    expect(() => verifyAccessToken(t, o)).toThrow(OAuthJwtError);
    const forgedKid = (() => {
      const body = `${b64({ ...hdr })}.${b64(claims)}`;
      return `${body}.${sign(null, Buffer.from(body), foreign.privateKey).toString('base64url')}`;
    })();
    expect(() => verifyAccessToken(forgedKid, o)).toThrow(OAuthJwtError);
  });
  it('refuses a non-canonical base64url signature', () => {
    const [h, p, s] = good().split('.') as [string, string, string];
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const idx = alphabet.indexOf(s.at(-1)!);
    const twin = alphabet[(idx & ~0xf) | ((idx + 1) & 0xf)]!;
    const alt = `${s.slice(0, -1)}${twin}`;
    expect(Buffer.from(alt, 'base64url')).toEqual(Buffer.from(s, 'base64url'));
    expect(() => verifyAccessToken(`${h}.${p}.${alt}`, o)).toThrow(OAuthJwtError);
    expect(() => verifyAccessToken(`${h}.${p}.${s}=`, o)).toThrow(OAuthJwtError);
  });
  it('refuses malformed tokens with OAuthJwtError, never another error', () => {
    for (const t of [
      '',
      'a',
      'a.b',
      'a.b.c.d',
      '..',
      'e30.e30.AAAA',
      `${b64([])}.${b64(claims)}.AA`,
    ])
      expect(() => verifyAccessToken(t, o)).toThrow(OAuthJwtError);
  });
});

describe('parseOAuthIssuer', () => {
  it('accepts an http or https origin, with a port', () => {
    expect(parseOAuthIssuer('https://app.example.test')).toBe('https://app.example.test');
    expect(parseOAuthIssuer('http://app.127.0.0.1.nip.io:8080')).toBe(
      'http://app.127.0.0.1.nip.io:8080',
    );
  });
  it('refuses a missing value, a path, a trailing slash, a query, userinfo and other schemes', () => {
    for (const bad of [
      undefined,
      '',
      'https://app.example.test/',
      'https://app.example.test/oauth',
      'https://app.example.test?x=1',
      'https://app.example.test#frag',
      'https://user:secretpw@app.example.test',
      'https://app.example.test:443',
      'app.example.test',
      'ftp://app.example.test',
    ]) {
      expect(() => parseOAuthIssuer(bad)).toThrow('OAUTH_ISSUER');
    }
  });
  it('never puts the value in the message', () => {
    expect(() => parseOAuthIssuer('https://user:secretpw@app.example.test')).toThrow(
      /^(?!.*secretpw)/s,
    );
  });
});
