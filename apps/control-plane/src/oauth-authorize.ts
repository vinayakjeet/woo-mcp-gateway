import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAUTH_CSRF_INFO, OAUTH_SCOPE, hashToken, oauthSubKey } from '@woo/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { withTx } from './db.js';
import { sessionUser, sidFromCookie } from './api-session.js';
import { redirectMatches } from './oauth-clients.js';
import { consentHeaders, consentPage, errorHeaders, errorPage } from './oauth-consent-html.js';
import type { OAuthOptions } from './oauth.js';

const AUTHORIZE_PATH = '/oauth/authorize';
const CODE_TTL = '60 seconds';
const MAX_STATE = 1000;
const MAX_FIELDS = 40;
// base64url of a SHA-256 digest (RFC 7636 4.2).
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export type AuthRequest = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  state: string | null;
};

type Checked =
  | { kind: 'page'; message: string }
  | {
      kind: 'redirect';
      redirectUri: string;
      state: string | null;
      error: string;
      description: string;
    }
  | { kind: 'ok'; req: AuthRequest };

type Fields = Record<string, unknown>;

// undefined: not sent. null: sent more than once or not as text, which is never valid.
const one = (f: Fields, k: string): string | undefined | null => {
  const v = f[k];
  return v === undefined ? undefined : typeof v === 'string' ? v : null;
};

// RFC 6749 4.1.2.1. Until the client and the redirect URI are trusted nothing is redirected: the
// user sees a page. After that every error goes back to the client with state and iss.
async function check(o: OAuthOptions, f: Fields): Promise<Checked> {
  const clientId = one(f, 'client_id');
  if (!clientId || clientId.length > 200)
    return { kind: 'page', message: 'This app is not known here.' };
  const { rows } = await o.pool.query<{ name: string; redirect_uris: string[] }>(
    'select name, redirect_uris from oauth_clients where client_id = $1',
    [clientId],
  );
  const client = rows[0];
  if (!client) return { kind: 'page', message: 'This app is not known here.' };
  const redirectUri = one(f, 'redirect_uri');
  if (!redirectUri || !redirectMatches(client.redirect_uris, redirectUri))
    return { kind: 'page', message: 'The return address does not match what this app registered.' };

  const rawState = one(f, 'state');
  const stateOk = rawState === undefined || (rawState !== null && rawState.length <= MAX_STATE);
  const state = stateOk ? (rawState ?? null) : null;
  const fail = (error: string, description: string): Checked => ({
    kind: 'redirect',
    redirectUri,
    state,
    error,
    description,
  });
  if (!stateOk) return fail('invalid_request', 'state must be one short value');
  if (one(f, 'response_type') !== 'code')
    return fail('unsupported_response_type', 'response_type must be code');
  const challenge = one(f, 'code_challenge');
  if (one(f, 'code_challenge_method') !== 'S256' || !challenge || !CHALLENGE_RE.test(challenge))
    return fail('invalid_request', 'PKCE with code_challenge_method S256 is required');
  const rawScope = one(f, 'scope');
  const wanted =
    rawScope === undefined ? [] : rawScope === null ? [''] : rawScope.split(' ').filter(Boolean);
  if (wanted.some((s) => s !== OAUTH_SCOPE))
    return fail('invalid_scope', `The only scope is ${OAUTH_SCOPE}`);
  const resource = one(f, 'resource');
  if (resource !== undefined && resource !== o.resource)
    return fail('invalid_target', 'resource must be the gateway URL');
  return {
    kind: 'ok',
    req: {
      clientId,
      clientName: client.name,
      redirectUri,
      codeChallenge: challenge,
      scope: OAUTH_SCOPE,
      resource: o.resource,
      state,
    },
  };
}

// Appended by hand: URLSearchParams.set would re-encode the query the client registered.
function withParams(uri: string, params: Record<string, string | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null) q.set(k, v);
  return `${uri}${uri.includes('?') ? '&' : '?'}${q.toString()}`;
}

const fieldsOf = (r: AuthRequest): Record<string, string> => ({
  response_type: 'code',
  client_id: r.clientId,
  redirect_uri: r.redirectUri,
  code_challenge: r.codeChallenge,
  code_challenge_method: 'S256',
  scope: r.scope,
  resource: r.resource,
  ...(r.state === null ? {} : { state: r.state }),
});

// The request as the GET page saw it, so the login detour can come back to it.
const authorizeUrl = (r: AuthRequest): string =>
  `${AUTHORIZE_PATH}?${new URLSearchParams(fieldsOf(r)).toString()}`;

// Bound to the session and to every field the user is approving, so a form from another session or
// with a changed field fails (decision 10).
function csrfToken(key: Buffer, sid: string, r: AuthRequest): string {
  const canonical = JSON.stringify([
    'v1',
    r.clientId,
    r.redirectUri,
    r.codeChallenge,
    r.scope,
    r.resource,
    r.state,
  ]);
  return createHmac('sha256', key).update(`${sid}\n${canonical}`).digest('base64url');
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function html(reply: FastifyReply, status: number, headers: Record<string, string>, body: string) {
  return reply.code(status).headers(headers).send(body);
}
const pageError = (reply: FastifyReply, status: number, message: string) =>
  html(reply, status, errorHeaders(), errorPage(message));

function parseForm(raw: string): Fields | null {
  const out: Fields = Object.create(null) as Fields;
  let count = 0;
  for (const [k, v] of new URLSearchParams(raw)) {
    if (++count > MAX_FIELDS) return null;
    out[k] = k in out ? [out[k]] : v;
  }
  return out;
}

export async function authorizeRoutes(scope: FastifyInstance, o: OAuthOptions): Promise<void> {
  const csrfKey = oauthSubKey(o.jwtKey, OAUTH_CSRF_INFO);

  scope.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 16_384 },
    (_req, body, done) => {
      const fields = parseForm(body as string);
      if (fields) done(null, fields);
      else done(Object.assign(new Error('too many fields'), { statusCode: 400 }));
    },
  );

  const sessionOf = async (cookie: string | undefined) => {
    const sid = sidFromCookie(cookie);
    const user = sid ? await sessionUser(o.pool, sid) : null;
    return sid && user ? { sid, user } : null;
  };

  scope.get(AUTHORIZE_PATH, async (req, reply) => {
    const c = await check(o, req.query as Fields);
    if (c.kind === 'page') return pageError(reply, 400, c.message);
    if (c.kind === 'redirect')
      return reply.redirect(
        withParams(c.redirectUri, {
          error: c.error,
          error_description: c.description,
          state: c.state,
          iss: o.issuer,
        }),
        302,
      );
    const session = await sessionOf(req.headers.cookie);
    if (!session) return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`, 302);
    const { req: r } = c;
    return html(
      reply,
      200,
      consentHeaders(new URL(r.redirectUri).origin),
      consentPage({
        clientName: r.clientName,
        clientNote: 'unverified, self-registered',
        redirectUri: r.redirectUri,
        email: session.user.email,
        fields: { ...fieldsOf(r), csrf: csrfToken(csrfKey, session.sid, r) },
      }),
    );
  });

  scope.post(AUTHORIZE_PATH, { bodyLimit: 16_384 }, async (req, reply) => {
    // Only the consent form posts here. Fastify still has its JSON and text parsers in this scope.
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/x-www-form-urlencoded'))
      return pageError(reply, 415, 'This form must be posted from the consent page.');
    const f = (req.body ?? {}) as Fields;
    const c = await check(o, f);
    if (c.kind === 'page') return pageError(reply, 400, c.message);
    if (c.kind === 'redirect')
      return reply.redirect(
        withParams(c.redirectUri, {
          error: c.error,
          error_description: c.description,
          state: c.state,
          iss: o.issuer,
        }),
        303,
      );
    const { req: r } = c;
    const session = await sessionOf(req.headers.cookie);
    if (!session) return reply.redirect(`/login?next=${encodeURIComponent(authorizeUrl(r))}`, 303);
    const sent = one(f, 'csrf');
    if (!sent || !sameToken(sent, csrfToken(csrfKey, session.sid, r)))
      return pageError(reply, 403, 'This form is no longer valid.');
    const decision = one(f, 'decision');
    if (decision === 'deny')
      return reply.redirect(
        withParams(r.redirectUri, {
          error: 'access_denied',
          error_description: 'The user denied the request',
          state: r.state,
          iss: o.issuer,
        }),
        303,
      );
    if (decision !== 'approve') return pageError(reply, 400, 'Choose Approve or Deny.');

    const code = randomBytes(32).toString('base64url');
    await withTx(o.pool, async (db) => {
      // Rows that expired a day ago serve no purpose, and this is the one place that adds them.
      await db.query(`delete from oauth_codes where expires_at < now() - interval '1 day'`);
      await db.query(
        `insert into oauth_codes
           (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, now() + interval '${CODE_TTL}')`,
        [
          hashToken(code),
          r.clientId,
          session.user.id,
          r.redirectUri,
          r.codeChallenge,
          r.resource,
          r.scope,
        ],
      );
      await db.query(
        `insert into oauth_consents (user_id, client_id, scope) values ($1, $2, $3)
         on conflict (user_id, client_id) do update set scope = excluded.scope, created_at = now()`,
        [session.user.id, r.clientId, r.scope],
      );
    });
    return reply.redirect(withParams(r.redirectUri, { code, state: r.state, iss: o.issuer }), 303);
  });
}
