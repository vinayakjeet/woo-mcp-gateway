import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ACCESS_TOKEN_TTL_S,
  OAUTH_SCOPE,
  hashToken,
  oauthKeys,
  signAccessToken,
  type OAuthKeys,
} from '@woo/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { withTx } from './db.js';
import { isForm, one, type Fields } from './oauth-form.js';
import type { OAuthOptions } from './oauth.js';

export const TOKEN_PATH = '/oauth/token';
const REFRESH_TTL = '30 days';
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

// RFC 6749 5.1. Nothing here is logged: the route's error handler logs the error code only.
function tokenBody(o: OAuthOptions, keys: OAuthKeys, g: Granted, refresh: string): Issued {
  return {
    access_token: signAccessToken({
      keys,
      iss: o.issuer,
      aud: g.resource,
      sub: g.userId,
      clientId: g.clientId,
      scope: g.scope,
    }),
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: refresh,
    scope: g.scope,
  };
}

type Db = { query: import('pg').Pool['query'] };

async function insertRefresh(db: Db, g: Granted): Promise<{ id: string; token: string }> {
  const token = `urt_${randomBytes(32).toString('base64url')}`;
  const { rows } = await db.query<{ id: string }>(
    `insert into oauth_refresh_tokens (token_hash, client_id, user_id, resource, scope, expires_at)
     values ($1, $2, $3, $4, $5, now() + interval '${REFRESH_TTL}') returning id`,
    [hashToken(token), g.clientId, g.userId, g.resource, g.scope],
  );
  return { id: rows[0]!.id, token };
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
    };
    // FOR UPDATE makes a second request for the same token wait for the first to commit, then see
    // it revoked with a successor. Whoever loses that race is treated as a reuse (decision 15).
    const out = await withTx(o.pool, async (db): Promise<Fail | (Granted & { token: string })> => {
      const { rows } = await db.query<Row>(
        `select id, client_id, user_id, resource, scope, revoked_at is not null as revoked, replaced_by,
                expires_at > now() as live
           from oauth_refresh_tokens where token_hash = $1 for update`,
        [hashToken(presented)],
      );
      const row = rows[0];
      if (!row) return invalidGrant();
      if (row.revoked) {
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
      if (row.client_id !== clientId || !row.live) return invalidGrant();
      if (row.resource !== o.resource)
        return bad('invalid_target', 'resource must be the gateway URL');
      if (!(await userIsActive(db, row.user_id))) return invalidGrant();
      // Narrow, never widen.
      let scopeOut = row.scope;
      if (asked !== undefined) {
        const have = new Set(row.scope.split(' ').filter(Boolean));
        const want = [...new Set(asked.split(' ').filter(Boolean))];
        if (want.length === 0 || !want.every((s) => have.has(s)))
          return bad('invalid_scope', 'scope may only narrow the original scope');
        scopeOut = want.join(' ');
      }
      const g: Granted = { clientId, userId: row.user_id, resource: row.resource, scope: scopeOut };
      const next = await insertRefresh(db, g);
      await db.query(
        'update oauth_refresh_tokens set revoked_at = now(), replaced_by = $2 where id = $1',
        [row.id, next.id],
      );
      return { ...g, token: next.token };
    });
    if ('error' in out) return out;
    return tokenBody(o, keys, out, out.token);
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
