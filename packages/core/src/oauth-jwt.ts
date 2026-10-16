import {
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

export const ACCESS_TOKEN_TYP = 'at+jwt';
export const ACCESS_TOKEN_TTL_S = 900;
export const OAUTH_SCOPE = 'mcp:tools';
// One label per use, so the signing seed and the consent CSRF key never share bytes.
export const OAUTH_EDDSA_INFO = 'urumi oauth eddsa v1';
export const OAUTH_CSRF_INFO = 'urumi oauth csrf v1';
// Pods share one node clock locally, but a VPS node and a future second node may drift.
const CLOCK_SKEW_S = 30;
// DER prefix that wraps a raw 32-byte Ed25519 seed as a PKCS#8 private key.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OAuthKeys = { privateKey: KeyObject; publicKey: KeyObject; kid: string };

export type AccessClaims = {
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  scope: string;
  iat: number;
  exp: number;
  jti: string;
};

export class OAuthJwtError extends Error {}

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const nowS = () => Math.floor(Date.now() / 1000);

export function oauthSubKey(jwtSigningKey: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', jwtSigningKey, Buffer.alloc(0), info, 32));
}

// The control-plane signs and the gateway verifies from the same secret, so no key is shipped
// between them (decision A1). Rotating JWT_SIGNING_KEY ends every access token at once.
export function oauthKeys(jwtSigningKey: string): OAuthKeys {
  const seed = oauthSubKey(jwtSigningKey, OAUTH_EDDSA_INFO);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const kid = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return { privateKey, publicKey, kid };
}

export function signAccessToken(o: {
  keys: OAuthKeys;
  iss: string;
  aud: string;
  sub: string;
  clientId: string;
  scope: string;
  ttlSeconds?: number;
  now?: number;
}): string {
  const ttl = o.ttlSeconds ?? ACCESS_TOKEN_TTL_S;
  if (ttl <= 0 || ttl > ACCESS_TOKEN_TTL_S) throw new OAuthJwtError('ttl must be 1 to 900 seconds');
  const iat = o.now ?? nowS();
  const claims: AccessClaims = {
    iss: o.iss,
    aud: o.aud,
    sub: o.sub,
    client_id: o.clientId,
    scope: o.scope,
    iat,
    exp: iat + ttl,
    jti: randomUUID(),
  };
  const body = `${enc({ alg: 'EdDSA', typ: ACCESS_TOKEN_TYP, kid: o.keys.kid })}.${enc(claims)}`;
  return `${body}.${sign(null, Buffer.from(body), o.keys.privateKey).toString('base64url')}`;
}

function decode(part: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new OAuthJwtError('malformed token');
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

function signatureOk(body: string, sig: Buffer, publicKey: KeyObject): boolean {
  try {
    return verify(null, Buffer.from(body), publicKey, sig);
  } catch {
    return false;
  }
}

// Messages never carry token content, so a caller can log them.
export function verifyAccessToken(
  token: string,
  o: { publicKey: KeyObject; kid: string; iss: string; aud: string; now?: number },
): AccessClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new OAuthJwtError('malformed token');
  const [h, p, s] = parts as [string, string, string];
  const header = decode(h);
  // The algorithm comes from our code, never from the token: only EdDSA, only our key.
  if (
    header.alg !== 'EdDSA' ||
    header.typ !== ACCESS_TOKEN_TYP ||
    header.kid !== o.kid ||
    header.crit !== undefined
  )
    throw new OAuthJwtError('wrong header');
  const got = Buffer.from(s, 'base64url');
  // Buffer.from ignores padding bits and a trailing "=", so several spellings decode to one signature.
  if (got.toString('base64url') !== s || !signatureOk(`${h}.${p}`, got, o.publicKey))
    throw new OAuthJwtError('bad signature');
  const c = decode(p);
  const now = o.now ?? nowS();
  if (c.iss !== o.iss || c.aud !== o.aud) throw new OAuthJwtError('wrong issuer or audience');
  if (typeof c.sub !== 'string' || !UUID.test(c.sub)) throw new OAuthJwtError('wrong subject');
  if (!nonEmpty(c.client_id) || !nonEmpty(c.jti)) throw new OAuthJwtError('missing client or id');
  if (typeof c.scope !== 'string' || !c.scope.split(' ').includes(OAUTH_SCOPE))
    throw new OAuthJwtError('wrong scope');
  if (
    typeof c.exp !== 'number' ||
    typeof c.iat !== 'number' ||
    !isFinite(c.exp) ||
    !isFinite(c.iat)
  )
    throw new OAuthJwtError('missing times');
  if (c.exp <= c.iat || c.exp - c.iat > ACCESS_TOKEN_TTL_S || c.iat > now + CLOCK_SKEW_S)
    throw new OAuthJwtError('bad issued-at time');
  if (c.exp <= now - CLOCK_SKEW_S) throw new OAuthJwtError('expired');
  return c as AccessClaims;
}
