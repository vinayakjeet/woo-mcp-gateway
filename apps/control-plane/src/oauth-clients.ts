import { randomBytes } from 'node:crypto';
import type pg from 'pg';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_REDIRECT_URIS = 5;
const MAX_URI_LENGTH = 2000;
// What a plain DNS name or IPv4 address looks like once the URL parser has applied punycode.
const PLAIN_HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const MAX_NAME_CHARS = 100;
const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
const RESPONSE_TYPES = ['code'] as const;

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// RFC 8252 7.3. The name check is on the parsed host, so localhost.evil.example is not loopback.
export function isLoopback(raw: string): boolean {
  const u = parse(raw);
  return u !== null && u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
}

// A redirect URI is where the code goes, so it must be an https URL or an http loopback URL that
// carries no fragment and no userinfo. Anything that could hide a second host is refused.
export function validateRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URI_LENGTH) return false;
  // The URL parser silently drops tabs and newlines, so they are refused before parsing.
  if (/[\p{Cc}\s]/u.test(raw) || raw.includes('#')) return false;
  const u = parse(raw);
  if (!u || u.username !== '' || u.password !== '') return false;
  // The URL parser accepts hosts such as a;b.example. The consent page puts the origin into a CSP
  // directive, so only hosts that cannot carry a separator are allowed.
  if (!PLAIN_HOST.test(u.hostname) && u.hostname !== '[::1]') return false;
  return u.protocol === 'https:' || isLoopback(raw);
}

// Exact string match. The one exception is an http loopback URI, where the port is ignored because
// a native app picks a free port on every run (RFC 8252 7.3). Scheme, host, path and query still match.
export function redirectMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  const p = parse(presented);
  if (!p || !isLoopback(presented) || presented.includes('#')) return false;
  if (p.username !== '' || p.password !== '') return false;
  return registered.some((r) => {
    const u = parse(r);
    return (
      u !== null &&
      isLoopback(r) &&
      u.hostname === p.hostname &&
      u.pathname === p.pathname &&
      u.search === p.search
    );
  });
}

// The consent page shows this name, so control and bidi characters (\p{C}) that could reorder or
// hide text are removed, and the length is counted in code points.
export function cleanClientName(raw: unknown): string {
  const cleaned = typeof raw === 'string' ? raw.replace(/\p{C}/gu, '').trim() : '';
  const capped = Array.from(cleaned).slice(0, MAX_NAME_CHARS).join('').trim();
  return capped === '' ? 'Unnamed client' : capped;
}

export type Registration =
  | { ok: true; name: string; redirectUris: string[] }
  | { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string };

const metadataError = (description: string): Registration => ({
  ok: false,
  error: 'invalid_client_metadata',
  description,
});

function subsetOf(value: unknown, allowed: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'string' && allowed.includes(v))
  );
}

// RFC 7591. Public clients only: PKCE is the proof of possession, so no client secret is issued.
// Fields we do not use are ignored, not stored.
export function parseRegistration(body: unknown): Registration {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return metadataError('The body must be a JSON object');
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS)
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`,
    };
  if (!uris.every(validateRedirectUri))
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description:
        'Each redirect URI must be https, or http on localhost, 127.0.0.1 or [::1], with no fragment or userinfo',
    };
  if (b.client_name !== undefined && typeof b.client_name !== 'string')
    return metadataError('client_name must be a string');
  if (b.grant_types !== undefined && !subsetOf(b.grant_types, GRANT_TYPES))
    return metadataError('grant_types may list authorization_code and refresh_token only');
  if (b.response_types !== undefined && !subsetOf(b.response_types, RESPONSE_TYPES))
    return metadataError('response_types may list code only');
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none')
    return metadataError('token_endpoint_auth_method must be none: public clients use PKCE');
  return { ok: true, name: cleanClientName(b.client_name), redirectUris: [...new Set(uris)] };
}

export async function insertDcrClient(
  pool: pg.Pool,
  r: { name: string; redirectUris: string[] },
): Promise<{ clientId: string; issuedAt: number }> {
  // 16 random bytes are 22 base64url characters.
  const clientId = `dcr_${randomBytes(16).toString('base64url')}`;
  const { rows } = await pool.query<{ issued: number }>(
    `insert into oauth_clients (client_id, name, redirect_uris)
     values ($1, $2, $3::jsonb) returning extract(epoch from created_at)::bigint as issued`,
    [clientId, r.name, JSON.stringify(r.redirectUris)],
  );
  return { clientId, issuedAt: Number(rows[0]!.issued) };
}

export { GRANT_TYPES, RESPONSE_TYPES };
