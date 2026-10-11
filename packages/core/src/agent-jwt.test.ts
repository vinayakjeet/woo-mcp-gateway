import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentJwtError, signAgentJwt, verifyAgentJwt } from './agent-jwt.js';

const key = 'k'.repeat(64);
const aud = 'http://gateway.platform.svc.cluster.local:8080/mcp';
const now = 1_800_000_000;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const forge = (header: object, claims: object, k = key) => {
  const body = `${b64(header)}.${b64(claims)}`;
  return `${body}.${createHmac('sha256', k).update(body).digest('base64url')}`;
};
const good = {
  iss: 'control-plane',
  aud,
  sub: 'u1',
  act: { sub: 'agent' },
  iat: now,
  exp: now + 300,
};
const hdr = { alg: 'HS256', typ: 'agent+jwt' };

describe('agent JWT', () => {
  it('round trips with typ agent+jwt and the SPEC claims', () => {
    const t = signAgentJwt({ key, userId: 'u1', audience: aud, now });
    expect(JSON.parse(Buffer.from(t.split('.')[0]!, 'base64url').toString())).toEqual(hdr);
    expect(verifyAgentJwt(t, { key, audience: aud, now })).toEqual(good);
  });
  it('refuses to sign for more than 5 minutes', () => {
    expect(() =>
      signAgentJwt({ key, userId: 'u1', audience: aud, ttlSeconds: 301, now }),
    ).toThrow();
  });
  it.each([
    ['wrong key', forge(hdr, good, 'x')],
    ['alg none', `${b64({ alg: 'none', typ: 'agent+jwt' })}.${b64(good)}.`],
    ['wrong typ', forge({ alg: 'HS256', typ: 'JWT' }, good)],
    ['wrong aud', forge(hdr, { ...good, aud: 'http://evil/mcp' })],
    ['wrong iss', forge(hdr, { ...good, iss: 'someone' })],
    ['missing act', forge(hdr, { ...good, act: undefined })],
    ['expired', forge(hdr, { ...good, exp: now - 31 })],
    ['too long lived', forge(hdr, { ...good, exp: now + 3600 })],
    ['garbage', 'a.b'],
  ])('rejects %s', (_name, token) => {
    expect(() => verifyAgentJwt(token, { key, audience: aud, now })).toThrow(AgentJwtError);
  });
});
