import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ACCESS_TOKEN_TTL_S,
  OAUTH_REFRESH_INFO,
  OAUTH_SCOPE,
  hashToken,
  oauthKeys,
  oauthSubKey,
  signAccessToken,
  type OAuthKeys,
} from '@woo/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { withTx } from './db.js';
import { isForm, one, type Fields } from './oauth-form.js';
import type { OAuthOptions } from './oauth.js';

export const TOKEN_PATH = '/oauth/token';
const REFRESH_TTL = '30 days';
// A client that sends the same refresh twice (a retry after a lost answer, two threads) must not
// lose its grant. Inside this window the previous token gets the pair it got the first time.
const REFRESH_GRACE = '30 seconds';
// RFC 7636 4.1: 43 to 128 unreserved characters.
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const REFRESH_RE = /^urt_[A-Za-z0-9_-]{43}$/;
const MAX_CODE = 128;

type Fail = { status: 400 | 401; error: string; description: string };
type Granted = { clientId: string; userId: string; resource: string; scope: string };
type Issued = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
};

const bad = (error: string, description: string): Fail => ({ status: 400, error, description });
const invalidGrant = (): Fail =>
  bad('invalid_grant', 'The grant is invalid, expired or already used');
const fail = (reply: FastifyReply, f: Fail) =>
  reply.code(f.status).send({ error: f.error, error_description: f.description });

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Fixes the access token's iat and jti to the successor row, so a replay signs the same bytes.
type Stamp = { now: number; jti: string };

// RFC 6749 5.1. Nothing here is logged: the route's error handler logs the error code only.
function tokenBody(
  o: OAuthOptions,
  keys: OAuthKeys,
  g: Granted,
  refresh: string,
  stamp?: Stamp,
): Issued {
  return {
    access_token: signAccessToken({
      keys,
      iss: o.issuer,
      aud: g.resource,
      sub: g.userId,
      clientId: g.clientId,
      scope: g.scope,
      ...stamp,
    }),
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: refresh,
    scope: g.scope,
  };
}

type Db = { query: import('pg').Pool['query'] };

async function insertRefresh(
  db: Db,
  g: Granted,
  token = `urt_${randomBytes(32).toString('base64url')}`,
): Promise<{ id: string; token: string; iat: number }> {
  const { rows } = await db.query<{ id: string; iat: number }>(
    `insert into oauth_refresh_tokens (token_hash, client_id, user_id, resource, scope, expires_at)
     values ($1, $2, $3, $4, $5, now() + interval '${REFRESH_TTL}')
     returning id, floor(extract(epoch from created_at))::int as iat`,
    [hashToken(token), g.clientId, g.userId, g.resource, g.scope],
  );
  return { id: rows[0]!.id, token, iat: rows[0]!.iat };
}

// RFC 6749 6: the new scope may be narrower than the old one, never wider.
function narrow(have: string, asked: string | undefined): string | Fail {
  if (asked === undefined) return have;
  const allowed = new Set(have.split(' ').filter(Boolean));
  const want = [...new Set(asked.split(' ').filter(Boolean))];
  if (want.length === 0 || !want.every((s) => allowed.has(s)))
    return bad('invalid_scope', 'scope may only narrow the original scope');
  return want.join(' ');
}

const userIsActive = async (db: Db, userId: string): Promise<boolean> =>
  ((await db.query(`select 1 from users where id = $1 and status = 'active'`, [userId])).rowCount ??
    0) > 0;

export async function tokenRoutes(
  scope: FastifyInstance,
  o: OAuthOptions,
  limit: object,
): Promise<void> {
  const keys = oauthKeys(o.jwtKey);
  // A rotation's successor token is a keyed hash of the token presented, not a random value. Only
  // the hash of a refresh token is stored, so this is how a replay inside the grace window can hand
  // back the same token without a new column. The input is the plaintext, which a database leak
  // does not have, and the output is 256 bits that nobody can compute without JWT_SIGNING_KEY.
  const refreshKey = oauthSubKey(o.jwtKey, OAUTH_REFRESH_INFO);
  const successorOf = (presented: string) =>
    `urt_${createHmac('sha256', refreshKey).update(presented).digest('base64url')}`;

  async function codeGrant(clientId: string, f: Fields): Promise<Fail | Issued> {
    const code = one(f, 'code');
    const redirectUri = one(f, 'redirect_uri');
    const verifier = one(f, 'code_verifier');
    const resource = one(f, 'resource');
    if (!code || !redirectUri || !verifier || resource === null)
      return bad('invalid_request', 'code, redirect_uri and code_verifier are required');
    if (!VERIFIER_RE.test(verifier)) return bad('invalid_request', 'code_verifier is not valid');
    if (resource !== undefined && resource !== o.resource)
      return bad('invalid_target', 'resource must be the gateway URL');
    if (code.length > MAX_CODE) return invalidGrant();
    // One statement both checks and spends the code, so two parallel requests cannot both win. It is
    // spent even if a later check fails: a code is never given a second try.
    const { rows } = await o.pool.query<{
      client_id: string;
      user_id: string;
      redirect_uri: string;
      code_challenge: string;
      resource: string;
      scope: string;
    }>(
      `update oauth_codes set used_at = now()
        where code_hash = $1 and used_at is null and expires_at > now()
        returning client_id, user_id, redirect_uri, code_challenge, resource, scope`,
      [hashToken(code)],
    );
    const row = rows[0];
    if (!row || row.client_id !== clientId || row.redirect_uri !== redirectUri)
      return invalidGrant();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (!sameText(challenge, row.code_challenge)) return invalidGrant();
    if (row.resource !== o.resource)
      return bad('invalid_target', 'resource must be the gateway URL');
    if (!(await userIsActive(o.pool, row.user_id))) return invalidGrant();
    const g: Granted = { clientId, userId: row.user_id, resource: row.resource, scope: row.scope };
    const refresh = await insertRefresh(o.pool, g);
    return tokenBody(o, keys, g, refresh.token);
  }

  async function refreshGrant(clientId: string, f: Fields): Promise<Fail | Issued> {
    const presented = one(f, 'refresh_token');
    const asked = one(f, 'scope');
    const resource = one(f, 'resource');
    if (presented === undefined || presented === null || asked === null || resource === null)
      return bad('invalid_request', 'refresh_token is required');
    if (resource !== undefined && resource !== o.resource)
      return bad('invalid_target', 'resource must be the gateway URL');
    if (!REFRESH_RE.test(presented)) return invalidGrant();

    type Row = {
      id: string;
      client_id: string;
      user_id: string;
      resource: string;
      scope: string;
      revoked: boolean;
      replaced_by: string | null;
      live: boolean;
      recent: boolean;
    };
    type Rotated = { g: Granted; token: string; stamp: Stamp };
    // FOR UPDATE makes a second request for the same token wait for the first to commit, then see
    // it revoked with a successor. That second request is a replay, not a theft, while the token
    // is the live one's direct parent and the rotation is under REFRESH_GRACE old.
    const out = await withTx(o.pool, async (db): Promise<Fail | Rotated> => {
      const { rows } = await db.query<Row>(
        `select id, client_id, user_id, resource, scope, revoked_at is not null as revoked, replaced_by,
                expires_at > now() as live,
                coalesce(revoked_at > now() - interval '${REFRESH_GRACE}', false) as recent
           from oauth_refresh_tokens where token_hash = $1 for update`,
        [hashToken(presented)],
      );
      const row = rows[0];
      if (!row) return invalidGrant();
      if (row.revoked) {
        // The successor must be the live head of the chain and the very token this one derives. A
        // successor that was used, revoked, expired or made by hand makes this a reuse.
        const successor =
          row.replaced_by !== null && row.recent && row.client_id === clientId
            ? (
                await db.query<{ id: string; scope: string; iat: number }>(
                  `select id, scope, floor(extract(epoch from created_at))::int as iat
                     from oauth_refresh_tokens
                    where id = $1 and token_hash = $2 and revoked_at is null and expires_at > now()`,
                  [row.replaced_by, hashToken(successorOf(presented))],
                )
              ).rows[0]
            : undefined;
        if (!successor) {
          // A rotated token coming back means two parties hold the chain. Every row after it goes,
          // the live one included, and the client has to authorize again.
          if (row.replaced_by !== null) {
            await db.query(
              `with recursive chain(id, replaced_by) as (
                 select id, replaced_by from oauth_refresh_tokens where id = $1
                 union
                 select t.id, t.replaced_by from oauth_refresh_tokens t join chain c on t.id = c.replaced_by
               )
               update oauth_refresh_tokens set revoked_at = coalesce(revoked_at, now())
                where id in (select id from chain)`,
              [row.id],
            );
          }
          return invalidGrant();
        }
        if (row.resource !== o.resource)
          return bad('invalid_target', 'resource must be the gateway URL');
        if (!(await userIsActive(db, row.user_id))) return invalidGrant();
        // A replay answers with what the first request got. One that asks for a different scope is
        // not a replay: it gets no token, and the grant is left alone.
        if (asked !== undefined) {
          const wanted = narrow(row.scope, asked);
          if (typeof wanted !== 'string') return wanted;
          if (wanted !== successor.scope) return invalidGrant();
        }
        return {
          g: { clientId, userId: row.user_id, resource: row.resource, scope: successor.scope },
          token: successorOf(presented),
          stamp: { now: successor.iat, jti: successor.id },
        };
      }
      if (row.client_id !== clientId || !row.live) return invalidGrant();
      if (row.resource !== o.resource)
        return bad('invalid_target', 'resource must be the gateway URL');
      if (!(await userIsActive(db, row.user_id))) return invalidGrant();
      const scopeOut = narrow(row.scope, asked);
      if (typeof scopeOut !== 'string') return scopeOut;
      const g: Granted = { clientId, userId: row.user_id, resource: row.resource, scope: scopeOut };
      const next = await insertRefresh(db, g, successorOf(presented));
      await db.query(
        'update oauth_refresh_tokens set revoked_at = now(), replaced_by = $2 where id = $1',
        [row.id, next.id],
      );
      return { g, token: next.token, stamp: { now: next.iat, jti: next.id } };
    });
    if ('error' in out) return out;
    return tokenBody(o, keys, out.g, out.token, out.stamp);
  }

  scope.post(
    TOKEN_PATH,
    { bodyLimit: 16_384, config: { rateLimit: limit } },
    async (req, reply) => {
      if (!isForm(req))
        return fail(reply, bad('invalid_request', 'Send application/x-www-form-urlencoded'));
      const f = (req.body ?? {}) as Fields;
      const grant = one(f, 'grant_type');
      if (grant === undefined || grant === null)
        return fail(reply, bad('invalid_request', 'grant_type is required'));
      if (grant !== 'authorization_code' && grant !== 'refresh_token')
        return fail(
          reply,
          bad('unsupported_grant_type', 'Use authorization_code or refresh_token'),
        );
      const clientId = one(f, 'client_id');
      if (!clientId) return fail(reply, bad('invalid_request', 'client_id is required'));
      const known = await o.pool.query('select 1 from oauth_clients where client_id = $1', [
        clientId,
      ]);
      if (known.rowCount === 0)
        return fail(reply, { status: 401, error: 'invalid_client', description: 'Unknown client' });
      const out = await (grant === 'authorization_code'
        ? codeGrant(clientId, f)
        : refreshGrant(clientId, f));
      return 'error' in out ? fail(reply, out) : reply.code(200).send(out);
    },
  );
}

export { OAUTH_SCOPE };
