import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAUTH_CSRF_INFO, OAUTH_SCOPE, hashToken, oauthSubKey, pinnedFetch } from '@woo/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withTx } from './db.js';
import { sessionUser, sidFromCookie } from './api-session.js';
import {
  MAX_CLIENT_ID_URL,
  fetchClientMetadata,
  hostOf,
  isCimdId,
  upsertCimdClient,
} from './oauth-cimd.js';
import { redirectMatches } from './oauth-clients.js';
import { isForm, one, type Fields } from './oauth-form.js';
import { consentHeaders, consentPage, errorHeaders, errorPage } from './oauth-consent-html.js';
import type { OAuthOptions } from './oauth.js';

const AUTHORIZE_PATH = '/oauth/authorize';
const CODE_TTL = '60 seconds';
const MAX_STATE = 1000;
// A fetch of a client's metadata document is a request the caller makes us send. Only a signed-in
// user can cause one, and each IP gets this many a minute.
const CIMD_PER_IP = 30;
const CIMD_WINDOW_MS = 60_000;
const MAX_DCR_CLIENT_ID = 200;
// base64url of a SHA-256 digest (RFC 7636 4.2).
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export type AuthRequest = {
  clientId: string;
  clientName: string;
  // What the consent page says about where the name comes from.
  clientNote: string;

  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  state: string | null;
};

type Client = { name: string; redirectUris: string[]; note: string };
type Loaded =
  | { kind: 'client'; clientId: string; client: Client }
  | { kind: 'page'; status: 400 | 429; message: string }
  | { kind: 'sign-in' };

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

// RFC 6749 4.1.2.1. Until the client and the redirect URI are trusted nothing is redirected: the
// user sees a page. After that every error goes back to the client with state and iss.
function check(o: OAuthOptions, f: Fields, clientId: string, client: Client): Checked {
  const redirectUri = one(f, 'redirect_uri');
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri))
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
      clientNote: client.note,
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

export async function authorizeRoutes(scope: FastifyInstance, o: OAuthOptions): Promise<void> {
  const csrfKey = oauthSubKey(o.jwtKey, OAUTH_CSRF_INFO);

  const sessionOf = async (cookie: string | undefined) => {
    const sid = sidFromCookie(cookie);
    const user = sid ? await sessionUser(o.pool, sid) : null;
    return sid && user ? { sid, user } : null;
  };

  const fetchDoc =
    o.cimdFetch ??
    pinnedFetch({ allowInsecure: false, ...(o.denyAddresses ? { deny: o.denyAddresses } : {}) });
  const cimdLimit = scope.createRateLimit({ max: CIMD_PER_IP, timeWindow: CIMD_WINDOW_MS });
  const unknownApp: Loaded = { kind: 'page', status: 400, message: 'This app is not known here.' };

  // Finds the client behind a client_id. A dcr_ id is a row. An https URL is fetched every time
  // (decision 24): the row is only a copy for the token endpoint, never a fallback, so a document
  // that goes away or changes stops working at the next authorize. The fetch needs a session and
  // is rate limited, and the user is told one thing whatever went wrong, because "resolves to a
  // private address" would let a signed-in user probe the cluster's DNS. The log has the reason.
  async function loadClient(req: FastifyRequest, f: Fields, signedIn: boolean): Promise<Loaded> {
    const clientId = one(f, 'client_id');
    if (!clientId) return unknownApp;
    if (isCimdId(clientId)) {
      if (clientId.length > MAX_CLIENT_ID_URL) return unknownApp;
      if (!signedIn) return { kind: 'sign-in' };
      // isAllowed is true only for allow-listed keys; a counted request is within the limit until isExceeded.
      const limit = await cimdLimit(req);
      if (!limit.isAllowed && limit.isExceeded)
        return {
          kind: 'page',
          status: 429,
          message: 'Too many requests from this address. Wait a minute and try again.',
        };
      const doc = await fetchClientMetadata(clientId, {
        fetch: fetchDoc,
        timeoutMs: o.cimdTimeoutMs,
      });
      if (!doc.ok) {
        req.log.warn({ reason: doc.reason, host: hostOf(clientId) }, 'client metadata refused');
        return {
          kind: 'page',
          status: 400,
          message: "This app's details could not be loaded from its web address.",
        };
      }
      await upsertCimdClient(o.pool, clientId, doc);
      const note = `metadata hosted at ${hostOf(clientId)}`;
      return {
        kind: 'client',
        clientId,
        client: { name: doc.name, redirectUris: doc.redirectUris, note },
      };
    }
    if (clientId.length > MAX_DCR_CLIENT_ID) return unknownApp;
    const { rows } = await o.pool.query<{ name: string; redirect_uris: string[] }>(
      'select name, redirect_uris from oauth_clients where client_id = $1',
      [clientId],
    );
    const row = rows[0];
    if (!row) return unknownApp;
    return {
      kind: 'client',
      clientId,
      client: {
        name: row.name,
        redirectUris: row.redirect_uris,
        note: 'unverified, self-registered',
      },
    };
  }

  scope.get(AUTHORIZE_PATH, async (req, reply) => {
    const session = await sessionOf(req.headers.cookie);
    const q = req.query as Fields;
    const loaded = await loadClient(req, q, session !== null);
    if (loaded.kind === 'page') return pageError(reply, loaded.status, loaded.message);
    if (loaded.kind === 'sign-in')
      return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`, 302);
    const c = check(o, q, loaded.clientId, loaded.client);
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
    if (!session) return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`, 302);
    const { req: r } = c;
    return html(
      reply,
      200,
      consentHeaders(new URL(r.redirectUri).origin),
      consentPage({
        clientName: r.clientName,
        clientNote: r.clientNote,
        redirectUri: r.redirectUri,
        email: session.user.email,
        fields: { ...fieldsOf(r), csrf: csrfToken(csrfKey, session.sid, r) },
      }),
    );
  });

  scope.post(AUTHORIZE_PATH, { bodyLimit: 16_384 }, async (req, reply) => {
    // Only the consent form posts here. Fastify still has its JSON and text parsers in this scope.
    if (!isForm(req))
      return pageError(reply, 415, 'This form must be posted from the consent page.');
    const f = (req.body ?? {}) as Fields;
    const session = await sessionOf(req.headers.cookie);
    const loaded = await loadClient(req, f, session !== null);
    if (loaded.kind === 'page') return pageError(reply, loaded.status, loaded.message);
    if (loaded.kind === 'sign-in')
      return pageError(reply, 403, 'Your sign-in ended. Open the app again to start over.');
    const c = check(o, f, loaded.clientId, loaded.client);
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
