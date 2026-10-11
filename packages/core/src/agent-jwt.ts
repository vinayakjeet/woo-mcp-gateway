import { createHmac, timingSafeEqual } from 'node:crypto';

export const AGENT_JWT_TYP = 'agent+jwt';
export const AGENT_JWT_ISSUER = 'control-plane';
export const AGENT_JWT_MAX_TTL_S = 300;
// Pods share one node clock locally, but a VPS node and a future second node may drift.
const CLOCK_SKEW_S = 30;

export type AgentClaims = {
  iss: string;
  aud: string;
  sub: string;
  act: { sub: 'agent' };
  iat: number;
  exp: number;
};

export class AgentJwtError extends Error {}

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (body: string, key: string) => createHmac('sha256', key).update(body).digest();
const nowS = () => Math.floor(Date.now() / 1000);

export function signAgentJwt(o: {
  key: string;
  userId: string;
  audience: string;
  ttlSeconds?: number;
  now?: number;
}): string {
  const ttl = o.ttlSeconds ?? AGENT_JWT_MAX_TTL_S;
  if (ttl <= 0 || ttl > AGENT_JWT_MAX_TTL_S)
    throw new AgentJwtError('ttl must be 1 to 300 seconds');
  const iat = o.now ?? nowS();
  const claims: AgentClaims = {
    iss: AGENT_JWT_ISSUER,
    aud: o.audience,
    sub: o.userId,
    act: { sub: 'agent' },
    iat,
    exp: iat + ttl,
  };
  const body = `${enc({ alg: 'HS256', typ: AGENT_JWT_TYP })}.${enc(claims)}`;
  return `${body}.${sign(body, o.key).toString('base64url')}`;
}

function decode(part: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (v && typeof v === 'object') return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AgentJwtError('malformed token');
}

export function verifyAgentJwt(
  token: string,
  o: { key: string; audience: string; now?: number },
): AgentClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AgentJwtError('malformed token');
  const [h, p, s] = parts as [string, string, string];
  const header = decode(h);
  if (header.alg !== 'HS256' || header.typ !== AGENT_JWT_TYP)
    throw new AgentJwtError('wrong header');
  const want = sign(`${h}.${p}`, o.key);
  const got = Buffer.from(s, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want))
    throw new AgentJwtError('bad signature');
  const c = decode(p);
  const now = o.now ?? nowS();
  const act = c.act as { sub?: unknown } | undefined;
  if (c.iss !== AGENT_JWT_ISSUER || c.aud !== o.audience)
    throw new AgentJwtError('wrong issuer or audience');
  if (typeof c.sub !== 'string' || c.sub === '' || act?.sub !== 'agent')
    throw new AgentJwtError('wrong subject');
  if (typeof c.exp !== 'number' || typeof c.iat !== 'number')
    throw new AgentJwtError('missing times');
  if (c.exp <= now - CLOCK_SKEW_S || c.exp > now + AGENT_JWT_MAX_TTL_S + CLOCK_SKEW_S)
    throw new AgentJwtError('expired or too long lived');
  return c as AgentClaims;
}
