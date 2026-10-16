import { createHash, randomBytes } from 'node:crypto';
import { hashToken } from '@woo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, TEST_JWT_KEY, call, testApi, userWithSession } from './test-app.js';

const base = process.env.TEST_DATABASE_URL;
const RESOURCE = 'http://mcp.127.0.0.1.nip.io/mcp';
const AUTH = '/oauth/authorize';

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

// The Origin a browser sends when a form on a page posts. A form submission is a navigation, not a
// CORS request, so the Fetch spec ("append a request Origin header") lets the page's own headers
// decide: no-referrer hides the origin as the string "null", a sandbox without allow-same-origin
// gives the page an opaque origin, and same-origin only hides it from another origin. The first
// version of the consent page sent no-referrer, which no test noticed because every test posted the
// real origin by hand.
export function browserFormOrigin(
  page: Record<string, unknown>,
  pageOrigin: string,
  actionOrigin: string,
): string {
  const csp = String(page['content-security-policy'] ?? '');
  const sandbox = csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .find((d) => d[0] === 'sandbox');
  if (sandbox && !sandbox.includes('allow-same-origin')) return 'null';
  // With no header a browser uses strict-origin-when-cross-origin.
  const policy = String(page['referrer-policy'] ?? 'strict-origin-when-cross-origin');
  if (policy === 'no-referrer') return 'null';
  if (policy === 'same-origin' && pageOrigin !== actionOrigin) return 'null';
  const downgrade = pageOrigin.startsWith('https:') && !actionOrigin.startsWith('https:');
  if (
    downgrade &&
    ['no-referrer-when-downgrade', 'strict-origin', 'strict-origin-when-cross-origin'].includes(
      policy,
    )
  )
    return 'null';
  return pageOrigin;
}

describe('browserFormOrigin models the Fetch rule', () => {
  const o = 'http://app.127.0.0.1.nip.io';
  it('sends null for no-referrer and for a sandbox without allow-same-origin', () => {
    expect(browserFormOrigin({ 'referrer-policy': 'no-referrer' }, o, o)).toBe('null');
    expect(
      browserFormOrigin(
        { 'content-security-policy': "default-src 'none'; sandbox allow-forms" },
        o,
        o,
      ),
    ).toBe('null');
  });
  it('sends the real origin for same-origin and for a sandbox that allows it', () => {
    expect(browserFormOrigin({ 'referrer-policy': 'same-origin' }, o, o)).toBe(o);
    expect(browserFormOrigin({}, o, o)).toBe(o);
    expect(
      browserFormOrigin(
        { 'content-security-policy': 'sandbox allow-forms allow-same-origin' },
        o,
        o,
      ),
    ).toBe(o);
  });
  it('same-origin hides the origin from another origin', () => {
    expect(browserFormOrigin({ 'referrer-policy': 'same-origin' }, o, 'http://other.example')).toBe(
      'null',
    );
  });
});

describe.skipIf(!base)('GET and POST /oauth/authorize (needs TEST_DATABASE_URL)', () => {
  let t: Awaited<ReturnType<typeof testApi>>;
  const logLines: string[] = [];
  let asha: { id: string; cookie: string };
  let other: { id: string; cookie: string };
  let loopbackClient: string;
  let httpsClient: string;
  let twinClient: string;

  async function addClient(name: string, redirectUris: string[]): Promise<string> {
    const clientId = `dcr_${randomBytes(16).toString('base64url')}`;
    await t.pool.query(
      `insert into oauth_clients (client_id, name, redirect_uris) values ($1, $2, $3::jsonb)`,
      [clientId, name, JSON.stringify(redirectUris)],
    );
    return clientId;
  }

  function query(over: Record<string, string | string[] | undefined> = {}): string {
    const p = new URLSearchParams();
    const all: Record<string, string | string[] | undefined> = {
      response_type: 'code',
      client_id: loopbackClient,
      redirect_uri: 'http://127.0.0.1:53682/callback',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      state: 'st-123',
      ...over,
    };
    for (const [k, v] of Object.entries(all)) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) p.append(k, one);
    }
    return `${AUTH}?${p.toString()}`;
  }
  const get = (url: string, cookie?: string) =>
    t.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

  function hidden(html: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g))
      out[m[1]!] = m[2]!
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&amp;', '&');
    return out;
  }
  function post(
    fields: Record<string, string>,
    o: { cookie?: string; origin?: string | null } = {},
  ) {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (o.cookie) headers.cookie = o.cookie;
    if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
    return t.app.inject({
      method: 'POST',
      url: AUTH,
      headers,
      payload: new URLSearchParams(fields).toString(),
    });
  }
  // The consent step a browser does: GET the page, read the hidden fields, post them back.
  async function consent(over: Record<string, string | undefined> = {}, cookie = asha.cookie) {
    const page = await get(query(over), cookie);
    expect(page.statusCode).toBe(200);
    return { page, fields: hidden(page.body) };
  }
  const location = (res: { headers: Record<string, unknown> }) =>
    new URL(String(res.headers.location));

  beforeAll(async () => {
    t = await testApi(
      'woo_oauth_authorize_test',
      {},
      { level: 'info', stream: { write: (s: string) => void logLines.push(s) } },
      { issuer: ORIGIN, jwtKey: TEST_JWT_KEY, resource: RESOURCE },
    );
    asha = await userWithSession(t.pool, 'asha-oauth@example.com', 'member');
    other = await userWithSession(t.pool, 'other-oauth@example.com', 'member');
    loopbackClient = await addClient('Claude Code', ['http://127.0.0.1/callback']);
    httpsClient = await addClient('Web App', ['https://client.example/cb?x=1']);
    // Same redirect URI as loopbackClient: only the client_id tells the two apart.
    twinClient = await addClient('Twin App', ['http://127.0.0.1/callback']);
  });
  afterAll(() => t.close());

  describe('before the redirect URI is trusted', () => {
    it('no session redirects to /login with the encoded authorize path as next', async () => {
      const url = query();
      const res = await get(url);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/login?next=${encodeURIComponent(url)}`);
    });

    it("a disabled user's session redirects to login", async () => {
      const gone = await userWithSession(t.pool, 'gone-oauth@example.com', 'member');
      await t.pool.query(`update users set status = 'disabled' where id = $1`, [gone.id]);
      const res = await get(query(), gone.cookie);
      expect(res.statusCode).toBe(302);
      expect(String(res.headers.location)).toMatch(/^\/login\?next=/);
    });

    it('an unknown client_id is a 400 page with no Location', async () => {
      for (const client_id of ['dcr_doesnotexist', '', undefined]) {
        const res = await get(query({ client_id }), asha.cookie);
        expect(res.statusCode).toBe(400);
        expect(res.headers.location).toBeUndefined();
        expect(res.headers['content-type']).toContain('text/html');
      }
    });

    it('a redirect_uri that does not match is a 400 page with no Location', async () => {
      for (const redirect_uri of [
        'http://127.0.0.1:53682/other',
        'http://127.0.0.1:53682/callback?x=1',
        'http://localhost:53682/callback',
        'https://evil.example/callback',
        'http://127.0.0.1.evil.example/callback',
        'http://user@127.0.0.1:53682/callback',
        '',
        undefined,
      ]) {
        const res = await get(query({ redirect_uri }), asha.cookie);
        expect(res.statusCode).toBe(400);
        expect(res.headers.location).toBeUndefined();
      }
      const https = await get(
        query({ client_id: httpsClient, redirect_uri: 'https://client.example/cb' }),
        asha.cookie,
      );
      expect(https.statusCode).toBe(400);
    });

    it('a mismatch is judged before the session: no login redirect for a bad redirect_uri', async () => {
      const res = await get(query({ redirect_uri: 'https://evil.example/cb' }));
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });

    it('a repeated client_id or redirect_uri is refused', async () => {
      const dup = await get(query({ client_id: [loopbackClient, loopbackClient] }), asha.cookie);
      expect(dup.statusCode).toBe(400);
      const dupUri = await get(
        query({ redirect_uri: ['http://127.0.0.1:1/callback', 'http://127.0.0.1:2/callback'] }),
        asha.cookie,
      );
      expect(dupUri.statusCode).toBe(400);
    });

    it('the error page escapes nothing it was sent and shows no request value', async () => {
      const res = await get(query({ client_id: '<script>alert(1)</script>' }), asha.cookie);
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('alert(1)');
    });
  });

  describe('errors after the redirect URI is trusted redirect with state and iss', () => {
    it.each([
      ['plain PKCE', { code_challenge_method: 'plain' }, 'invalid_request'],
      ['no code_challenge_method', { code_challenge_method: undefined }, 'invalid_request'],
      ['a missing challenge', { code_challenge: undefined }, 'invalid_request'],
      ['a short challenge', { code_challenge: 'abc' }, 'invalid_request'],
      [
        'a challenge with a bad character',
        { code_challenge: `${'a'.repeat(42)}!` },
        'invalid_request',
      ],
      [
        'a repeated challenge',
        { code_challenge: [pkce().challenge, pkce().challenge] },
        'invalid_request',
      ],
      ['response_type token', { response_type: 'token' }, 'unsupported_response_type'],
      ['no response_type', { response_type: undefined }, 'unsupported_response_type'],
      ['an unknown scope', { scope: 'mcp:tools admin' }, 'invalid_scope'],
      ['a different scope', { scope: 'openid' }, 'invalid_scope'],
      ['a foreign resource', { resource: 'https://evil.example/mcp' }, 'invalid_target'],
      ['the resource with a trailing slash', { resource: `${RESOURCE}/` }, 'invalid_target'],
      ['two resources', { resource: [RESOURCE, RESOURCE] }, 'invalid_target'],
    ])('%s is %s', async (_name, over, error) => {
      const res = await get(
        query(over as Record<string, string | string[] | undefined>),
        asha.cookie,
      );
      expect(res.statusCode).toBe(302);
      const loc = location(res);
      expect(`${loc.origin}${loc.pathname}`).toBe('http://127.0.0.1:53682/callback');
      expect(loc.searchParams.get('error')).toBe(error);
      expect(loc.searchParams.get('state')).toBe('st-123');
      expect(loc.searchParams.get('iss')).toBe(ORIGIN);
      expect(loc.searchParams.get('code')).toBeNull();
    });

    it('an error redirect does not need a session', async () => {
      const res = await get(query({ code_challenge_method: 'plain' }));
      expect(res.statusCode).toBe(302);
      expect(location(res).searchParams.get('error')).toBe('invalid_request');
    });

    it('omits state when the client sent none, and keeps the query of the redirect URI', async () => {
      const res = await get(
        query({
          client_id: httpsClient,
          redirect_uri: 'https://client.example/cb?x=1',
          response_type: 'token',
          state: undefined,
        }),
        asha.cookie,
      );
      const loc = location(res);
      expect(loc.searchParams.get('x')).toBe('1');
      expect(loc.searchParams.get('state')).toBeNull();
      expect(loc.searchParams.get('error')).toBe('unsupported_response_type');
    });

    it('accepts the resource, mcp:tools, and no scope or resource at all', async () => {
      for (const over of [{ resource: RESOURCE }, { scope: 'mcp:tools' }, {}]) {
        expect((await get(query(over), asha.cookie)).statusCode).toBe(200);
      }
    });
  });

  describe('the consent page', () => {
    it('names the client, marks a DCR client unverified, shows the full redirect URI and the email', async () => {
      const res = await get(query(), asha.cookie);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Claude Code');
      expect(res.body).toContain('unverified');
      expect(res.body).toContain('http://127.0.0.1:53682/callback');
      expect(res.body).toContain('asha-oauth@example.com');
      expect(res.body).toContain('Use the tools your role allows, as you');
    });

    it("has the CSP with frame-ancestors 'none' and form-action naming the redirect origin", async () => {
      const res = await get(query(), asha.cookie);
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:53682; frame-ancestors 'none'; base-uri 'none'",
      );
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toBe('no-store');
      // same-origin, not no-referrer: no-referrer makes a browser send Origin: null on the form post.
      // It still sends nothing to the client's redirect URI, which is another origin.
      expect(res.headers['referrer-policy']).toBe('same-origin');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('names an https redirect origin in form-action', async () => {
      const res = await get(
        query({ client_id: httpsClient, redirect_uri: 'https://client.example/cb?x=1' }),
        asha.cookie,
      );
      expect(res.headers['content-security-policy']).toContain(
        "form-action 'self' https://client.example;",
      );
    });

    it('has no JavaScript and no external resource', async () => {
      const res = await get(query(), asha.cookie);
      expect(res.body).not.toMatch(/<script/i);
      expect(res.body).not.toMatch(/\son[a-z]+\s*=/i);
      expect(res.body).not.toMatch(/(?:src|href)\s*=\s*["']?https?:/i);
      expect(res.body).not.toMatch(/<(?:img|iframe|link|object|embed)\b/i);
    });

    it('escapes a client name that holds HTML', async () => {
      const evil = await addClient('<script>alert(1)</script><img src=x onerror=alert(2)>', [
        'http://127.0.0.1/cb',
      ]);
      const res = await get(
        query({ client_id: evil, redirect_uri: 'http://127.0.0.1:9/cb' }),
        asha.cookie,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('<script>');
      expect(res.body).not.toContain('<img');
      expect(res.body).toContain('&lt;script&gt;');
    });

    it('escapes a redirect URI and a state that hold quotes', async () => {
      const c = await addClient('Quotes', ['https://client.example/cb?a=%22%3E%3Cb%3E']);
      const res = await get(
        query({
          client_id: c,
          redirect_uri: 'https://client.example/cb?a=%22%3E%3Cb%3E',
          state: '"><b>x</b>',
        }),
        asha.cookie,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('"><b>');
      expect(hidden(res.body).state).toBe('"><b>x</b>');
    });

    it('shows the port the client asked for, not the registered one', async () => {
      const res = await get(
        query({ redirect_uri: 'http://127.0.0.1:61234/callback' }),
        asha.cookie,
      );
      expect(res.body).toContain('http://127.0.0.1:61234/callback');
      expect(res.headers['content-security-policy']).toContain('http://127.0.0.1:61234');
    });

    it('carries the whole request in hidden fields and a CSRF token', async () => {
      const { fields } = await consent();
      expect(fields).toMatchObject({
        response_type: 'code',
        client_id: loopbackClient,
        redirect_uri: 'http://127.0.0.1:53682/callback',
        code_challenge_method: 'S256',
        scope: 'mcp:tools',
        resource: RESOURCE,
        state: 'st-123',
      });
      expect(fields.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('gives the same token for the same request and session, another for another session', async () => {
      const q = query();
      const a1 = hidden((await get(q, asha.cookie)).body).csrf;
      const a2 = hidden((await get(q, asha.cookie)).body).csrf;
      const b = hidden((await get(q, other.cookie)).body).csrf;
      expect(a1).toBe(a2);
      expect(a1).not.toBe(b);
    });
  });

  describe('POST', () => {
    it('without the CSRF token, with a token for another session, or with a foreign Origin is 403', async () => {
      const { fields } = await consent();
      const noToken = Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'csrf'));
      const go = { ...noToken, decision: 'approve' };
      expect((await post(go, { cookie: asha.cookie })).statusCode).toBe(403);
      expect(
        (await post({ ...go, csrf: 'x'.repeat(43) }, { cookie: asha.cookie })).statusCode,
      ).toBe(403);
      expect((await post({ ...go, csrf: '' }, { cookie: asha.cookie })).statusCode).toBe(403);
      const otherSession = hidden(
        (await get(query({ code_challenge: fields.code_challenge }), other.cookie)).body,
      );
      expect(
        (await post({ ...go, csrf: otherSession.csrf! }, { cookie: asha.cookie })).statusCode,
      ).toBe(403);
      const ok = { ...go, csrf: fields.csrf! };
      expect(
        (await post(ok, { cookie: asha.cookie, origin: 'http://evil.example' })).statusCode,
      ).toBe(403);
      expect((await post(ok, { cookie: asha.cookie, origin: null })).statusCode).toBe(403);
    });

    it('accepts the Origin a browser sends for the form post, taken from the headers the page set', async () => {
      for (const decision of ['approve', 'deny']) {
        const { page, fields } = await consent();
        const origin = browserFormOrigin(page.headers, ORIGIN, ORIGIN);
        expect(origin).toBe(ORIGIN);
        const res = await post({ ...fields, decision }, { cookie: asha.cookie, origin });
        expect(res.statusCode, decision).toBe(303);
        const to = location(res);
        if (decision === 'approve') expect(to.searchParams.get('code')).toBeTruthy();
        else expect(to.searchParams.get('error')).toBe('access_denied');
      }
    });

    it('still refuses Origin: null, which a no-referrer or sandboxed page sends, with a valid token', async () => {
      const { fields } = await consent();
      for (const decision of ['approve', 'deny']) {
        const res = await post({ ...fields, decision }, { cookie: asha.cookie, origin: 'null' });
        expect(res.statusCode, decision).toBe(403);
        expect(res.json()).toEqual({ error: 'bad_origin' });
      }
      const rows = await t.pool.query(
        'select count(*) as n from oauth_codes where code_challenge = $1',
        [fields.code_challenge],
      );
      expect(Number(rows.rows[0].n)).toBe(0);
    });

    it('logs the refused Origin and only the origin of the Referer, never its path', async () => {
      const { fields } = await consent();
      logLines.length = 0;
      await t.app.inject({
        method: 'POST',
        url: AUTH,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: asha.cookie,
          origin: 'null',
          referer: `${ORIGIN}/invite/SECRET-INVITE-TOKEN?x=1`,
        },
        payload: new URLSearchParams({ ...fields, decision: 'approve' }).toString(),
      });
      const line = logLines.map((l) => JSON.parse(l)).find((l) => l.msg === 'origin refused');
      expect(line).toMatchObject({ origin: 'null', refererOrigin: ORIGIN });
      const all = logLines.join('\n');
      expect(all).not.toContain('SECRET-INVITE-TOKEN');
      expect(all).not.toContain(fields.csrf!);
      expect(all).not.toContain(asha.cookie.split('=')[1]!);
    });

    it('with changed parameters after the GET is refused', async () => {
      const { fields } = await consent();
      const go = { ...fields, decision: 'approve' };
      const other2 = pkce().challenge;
      const changes: [Record<string, string>, number][] = [
        [{ redirect_uri: 'http://127.0.0.1:1/callback' }, 403],
        [{ code_challenge: other2 }, 403],
        [{ state: 'different' }, 403],
        [{ client_id: twinClient }, 403],
        [{ client_id: httpsClient }, 400],
      ];
      for (const [changed, status] of changes) {
        const res = await post({ ...go, ...changed }, { cookie: asha.cookie });
        expect(res.statusCode).toBe(status);
        expect(res.headers.location).toBeUndefined();
      }
      const rows = await t.pool.query(
        'select 1 from oauth_codes where code_challenge = $1 or client_id = $2',
        [other2, twinClient],
      );
      expect(rows.rowCount).toBe(0);
    });

    it('validates every parameter again: a bad redirect_uri never redirects', async () => {
      const { fields } = await consent();
      const res = await post(
        { ...fields, redirect_uri: 'https://evil.example/cb', decision: 'approve' },
        { cookie: asha.cookie },
      );
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });

    it('approve answers 303 with code, state and iss; the row has the hashed code, challenge, resource and a 60 s expiry', async () => {
      const { challenge } = pkce();
      const { fields } = await consent({ code_challenge: challenge });
      const res = await post({ ...fields, decision: 'approve' }, { cookie: asha.cookie });
      expect(res.statusCode).toBe(303);
      const loc = location(res);
      expect(`${loc.origin}${loc.pathname}`).toBe('http://127.0.0.1:53682/callback');
      const code = loc.searchParams.get('code')!;
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(loc.searchParams.get('state')).toBe('st-123');
      expect(loc.searchParams.get('iss')).toBe(ORIGIN);
      const { rows } = await t.pool.query(
        `select code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, used_at,
                extract(epoch from expires_at - now()) as ttl
           from oauth_codes where code_hash = $1`,
        [hashToken(code)],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        client_id: loopbackClient,
        user_id: asha.id,
        redirect_uri: 'http://127.0.0.1:53682/callback',
        code_challenge: challenge,
        resource: RESOURCE,
        scope: 'mcp:tools',
        used_at: null,
      });
      expect(Number(rows[0].ttl)).toBeGreaterThan(50);
      expect(Number(rows[0].ttl)).toBeLessThanOrEqual(60);
      const plain = await t.pool.query('select 1 from oauth_codes where code_hash = $1', [code]);
      expect(plain.rowCount).toBe(0);
    });

    it('stores the redirect URI as presented, with the port, and keeps the query of an https URI', async () => {
      const { fields } = await consent({ redirect_uri: 'http://127.0.0.1:61234/callback' });
      const res = await post({ ...fields, decision: 'approve' }, { cookie: asha.cookie });
      expect(location(res).origin).toBe('http://127.0.0.1:61234');
      const c = await consent({
        client_id: httpsClient,
        redirect_uri: 'https://client.example/cb?x=1',
      });
      const res2 = await post({ ...c.fields, decision: 'approve' }, { cookie: asha.cookie });
      expect(location(res2).searchParams.get('x')).toBe('1');
      expect(location(res2).searchParams.get('code')).toBeTruthy();
    });

    it('every approval gets a new code', async () => {
      const codes = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const { fields } = await consent();
        const res = await post({ ...fields, decision: 'approve' }, { cookie: asha.cookie });
        codes.add(location(res).searchParams.get('code')!);
      }
      expect(codes.size).toBe(3);
    });

    it('deny answers 303 with error=access_denied, state and iss, and stores no code', async () => {
      const { challenge } = pkce();
      const { fields } = await consent({ code_challenge: challenge });
      const res = await post({ ...fields, decision: 'deny' }, { cookie: asha.cookie });
      expect(res.statusCode).toBe(303);
      const loc = location(res);
      expect(loc.searchParams.get('error')).toBe('access_denied');
      expect(loc.searchParams.get('state')).toBe('st-123');
      expect(loc.searchParams.get('iss')).toBe(ORIGIN);
      expect(loc.searchParams.get('code')).toBeNull();
      const rows = await t.pool.query('select 1 from oauth_codes where code_challenge = $1', [
        challenge,
      ]);
      expect(rows.rowCount).toBe(0);
    });

    it('anything but approve or deny is a 400', async () => {
      const { fields } = await consent();
      for (const decision of ['', 'yes', 'APPROVE', 'approve,deny']) {
        const res = await post({ ...fields, decision }, { cookie: asha.cookie });
        expect(res.statusCode).toBe(400);
        expect(res.headers.location).toBeUndefined();
      }
      expect((await post(fields, { cookie: asha.cookie })).statusCode).toBe(400);
    });

    it('approve upserts oauth_consents, once per user and client', async () => {
      const u = await userWithSession(t.pool, 'consent-oauth@example.com', 'member');
      for (let i = 0; i < 2; i++) {
        const { fields } = await consent({}, u.cookie);
        await post({ ...fields, decision: 'approve' }, { cookie: u.cookie });
      }
      const { rows } = await t.pool.query(
        'select client_id, scope from oauth_consents where user_id = $1',
        [u.id],
      );
      expect(rows).toEqual([{ client_id: loopbackClient, scope: 'mcp:tools' }]);
    });

    it('deny does not record a consent', async () => {
      const u = await userWithSession(t.pool, 'denier-oauth@example.com', 'member');
      const { fields } = await consent({}, u.cookie);
      await post({ ...fields, decision: 'deny' }, { cookie: u.cookie });
      const { rowCount } = await t.pool.query('select 1 from oauth_consents where user_id = $1', [
        u.id,
      ]);
      expect(rowCount).toBe(0);
    });

    it('with no session it goes to login, and stores nothing', async () => {
      const { fields } = await consent();
      const res = await post({ ...fields, decision: 'approve' });
      expect(res.statusCode).toBe(303);
      expect(String(res.headers.location)).toMatch(/^\/login\?next=/);
      expect(String(res.headers.location)).not.toContain('csrf');
    });

    it('a user disabled after the GET gets no code', async () => {
      const u = await userWithSession(t.pool, 'late-gone-oauth@example.com', 'member');
      const { fields } = await consent({}, u.cookie);
      await t.pool.query(`update users set status = 'disabled' where id = $1`, [u.id]);
      const res = await post({ ...fields, decision: 'approve' }, { cookie: u.cookie });
      expect(String(res.headers.location ?? '')).not.toContain('code=');
      const { rowCount } = await t.pool.query('select 1 from oauth_codes where user_id = $1', [
        u.id,
      ]);
      expect(rowCount).toBe(0);
    });

    it('drops codes that expired more than a day ago when a new one is issued', async () => {
      await t.pool.query(
        `insert into oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, expires_at)
         values ('stale-hash', $1, $2, 'http://127.0.0.1/cb', 'c', $3, 'mcp:tools', now() - interval '2 days')`,
        [loopbackClient, asha.id, RESOURCE],
      );
      const { fields } = await consent();
      await post({ ...fields, decision: 'approve' }, { cookie: asha.cookie });
      const { rowCount } = await t.pool.query(
        `select 1 from oauth_codes where code_hash = 'stale-hash'`,
      );
      expect(rowCount).toBe(0);
    });

    it('a form body over 16 KiB is refused', async () => {
      const res = await post({ junk: 'x'.repeat(20_000) }, { cookie: asha.cookie });
      expect(res.statusCode).toBe(413);
    });

    it('a JSON or plain text body is refused', async () => {
      for (const [type, payload] of [
        ['application/json', JSON.stringify({ ...(await consent()).fields, decision: 'approve' })],
        ['text/plain', 'decision=approve'],
      ] as const) {
        const res = await t.app.inject({
          method: 'POST',
          url: AUTH,
          headers: { 'content-type': type, origin: ORIGIN, cookie: asha.cookie },
          payload,
        });
        expect(res.statusCode).toBe(415);
        expect(res.headers.location).toBeUndefined();
      }
    });
  });

  it('no code, CSRF token, session id or verifier appears in the log', async () => {
    const { verifier, challenge } = pkce();
    const { fields } = await consent({ code_challenge: challenge });
    const res = await post({ ...fields, decision: 'approve' }, { cookie: asha.cookie });
    const code = location(res).searchParams.get('code')!;
    await post({ ...fields, csrf: 'wrong', decision: 'approve' }, { cookie: asha.cookie });
    await call(t.app, 'POST', AUTH, { body: {}, origin: 'http://evil.example' });
    const log = logLines.join('\n');
    expect(log.length).toBeGreaterThan(0);
    for (const secret of [code, fields.csrf!, verifier, asha.cookie.slice(4)]) {
      expect(log).not.toContain(secret);
    }
  });
});
