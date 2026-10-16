import { createHash, randomBytes } from 'node:crypto';
import { oauthKeys, pinnedFetch, verifyAccessToken, type PinnedFetch } from '@woo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CIMD_MAX_BYTES, fetchClientMetadata, isCimdId, type CimdResult } from './oauth-cimd.js';
import { ORIGIN, TEST_JWT_KEY, testApi, userWithSession } from './test-app.js';

const base = process.env.TEST_DATABASE_URL;
const RESOURCE = 'http://mcp.127.0.0.1.nip.io/mcp';
const URL_OK = 'https://client.example/oauth/metadata.json';
const REDIRECT = 'http://127.0.0.1:53682/callback';

const doc = (over: Record<string, unknown> = {}) => ({
  client_id: URL_OK,
  client_name: 'Example Client',
  redirect_uris: ['http://127.0.0.1/callback', 'https://client.example/cb'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  ...over,
});
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
const serving =
  (make: () => Response | Promise<Response>): PinnedFetch =>
  async () =>
    make();
// Waits for the abort signal like a real stalled socket does.
const stalled: PinnedFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  });

const fail = (r: CimdResult) => (r.ok ? 'ok' : r.reason);

describe('isCimdId', () => {
  it('is true only for an https URL, so a dcr_ id and an http URL are never fetched', () => {
    expect(isCimdId(URL_OK)).toBe(true);
    expect(isCimdId('dcr_abc')).toBe(false);
    expect(isCimdId('http://client.example/m.json')).toBe(false);
    expect(isCimdId('HTTPS://client.example/m.json')).toBe(false);
  });
});

describe('fetchClientMetadata', () => {
  const get = (f: PinnedFetch, url = URL_OK, timeoutMs = 2000) =>
    fetchClientMetadata(url, { fetch: f, timeoutMs });

  it('returns the name and the redirect URIs of a good document, and asks for JSON', async () => {
    let seen: { url: string; accept: string | null; signal: boolean } | null = null;
    const f: PinnedFetch = async (url, init) => {
      seen = {
        url: String(url),
        accept: new Headers(init?.headers).get('accept'),
        signal: init?.signal instanceof AbortSignal,
      };
      return json(doc());
    };
    expect(await get(f)).toEqual({
      ok: true,
      name: 'Example Client',
      redirectUris: ['http://127.0.0.1/callback', 'https://client.example/cb'],
    });
    expect(seen).toEqual({ url: URL_OK, accept: 'application/json', signal: true });
  });

  it('accepts a +json content type and a missing client_name, and keeps an optional query in the URL', async () => {
    const url = 'https://client.example/m.json?v=2';
    const r = await get(
      serving(() =>
        json(doc({ client_id: url, client_name: undefined }), {
          headers: { 'content-type': 'application/client-metadata+json; charset=utf-8' },
        }),
      ),
      url,
    );
    expect(r).toMatchObject({ ok: true, name: 'Unnamed client' });
  });

  it('cleans and caps the name', async () => {
    // U+202E reverses text direction and U+0000 is a control character: both are removed.
    const hostile = `Evil${String.fromCharCode(0x202e, 0)}${'x'.repeat(200)}`;
    const r = await get(serving(() => json(doc({ client_name: hostile }))));
    expect(r.ok && r.name.length).toBe(100);
    expect(r.ok && r.name).not.toMatch(/\p{C}/u);
    expect(r.ok && r.name.startsWith('Evilxxx')).toBe(true);
  });

  describe.each([
    ['an http URL', 'http://client.example/m.json'],
    ['a URL with no path', 'https://client.example'],
    ['a URL with only a slash', 'https://client.example/'],
    ['a fragment', 'https://client.example/m.json#frag'],
    ['userinfo', 'https://user:pw@client.example/m.json'],
    ['a dot segment', 'https://client.example/a/../m.json'],
    ['a single dot segment', 'https://client.example/./m.json'],
    ['whitespace', 'https://client.example/m .json'],
    ['a very long URL', `https://client.example/${'a'.repeat(2100)}`],
    ['not a URL', 'https://'],
  ])('%s', (_name, url) => {
    it('is bad_url and nothing is fetched', async () => {
      let calls = 0;
      const f: PinnedFetch = async () => {
        calls += 1;
        return json(doc());
      };
      expect(fail(await get(f, url))).toBe('bad_url');
      expect(calls).toBe(0);
    });
  });

  it('refuses a private address, an IP literal and cluster names with the real pinned fetch', async () => {
    let resolved = 0;
    const real = pinnedFetch({
      allowInsecure: false,
      resolve: async () => {
        resolved += 1;
        return ['10.0.0.5'];
      },
    });
    // Resolves to a private address: refused at connect time, with no socket opened.
    expect(fail(await get(real, 'https://client.example/m.json'))).toBe('blocked');
    expect(resolved).toBe(1);
    for (const u of [
      'https://127.0.0.1/m.json',
      'https://169.254.169.254/latest/m.json',
      'https://[::1]/m.json',
      'https://metadata.google.internal/m.json',
      'https://control-plane.platform.svc.cluster.local/m.json',
      'https://localhost/m.json',
    ])
      expect(fail(await get(real, u)), u).toBe('blocked');
    expect(resolved).toBe(1);
  });

  it('treats a fetch that fails or is redirected as an error', async () => {
    const boom = serving(() => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    });
    expect(fail(await get(boom))).toBe('fetch');
    // pinnedFetch uses redirect: "error", so undici rejects a 3xx; a 3xx that gets through is refused too.
    expect(
      fail(
        await get(
          serving(
            () => new Response(null, { status: 302, headers: { location: 'https://x.example/' } }),
          ),
        ),
      ),
    ).toBe('status');
  });

  it.each([404, 500, 204, 201])('a %i answer is refused', async (status) => {
    const answer = () =>
      new Response(status === 204 ? null : JSON.stringify(doc()), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    expect(fail(await get(serving(answer)))).toBe('status');
  });

  it('refuses a body over 5 KB, whether or not content-length says so', async () => {
    const pad = 'x'.repeat(CIMD_MAX_BYTES);
    const big = JSON.stringify(doc({ client_name: pad }));
    expect(fail(await get(serving(() => json(big))))).toBe('too_large');
    expect(
      fail(
        await get(
          serving(() =>
            json(big, {
              headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
            }),
          ),
        ),
      ),
    ).toBe('too_large');
    // No content-length: a chunked stream that keeps going stops at the cap.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1024;
        c.enqueue(new TextEncoder().encode('x'.repeat(1024)));
      },
    });
    expect(
      fail(
        await get(
          serving(() => new Response(stream, { headers: { 'content-type': 'application/json' } })),
        ),
      ),
    ).toBe('too_large');
    expect(pulled).toBeLessThan(CIMD_MAX_BYTES * 4);
  });

  it('accepts a document just under the cap', async () => {
    const name = 'n'.repeat(90);
    const body = JSON.stringify(doc({ client_name: name, pad: 'x'.repeat(CIMD_MAX_BYTES - 700) }));
    expect(body.length).toBeLessThan(CIMD_MAX_BYTES);
    expect(fail(await get(serving(() => json(body))))).toBe('ok');
  });

  it('gives up on a stalled connection and on a body that never ends', async () => {
    const t0 = Date.now();
    expect(fail(await get(stalled, URL_OK, 50))).toBe('timeout');
    const hang = new ReadableStream<Uint8Array>({ start() {} });
    expect(
      fail(
        await get(
          serving(() => new Response(hang, { headers: { 'content-type': 'application/json' } })),
          URL_OK,
          50,
        ),
      ),
    ).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('refuses a body that is not JSON, not an object, or has the wrong content type', async () => {
    expect(fail(await get(serving(() => json('<html>nope</html>'))))).toBe('not_json');
    expect(fail(await get(serving(() => json('[]'))))).toBe('not_json');
    expect(fail(await get(serving(() => json('null'))))).toBe('not_json');
    expect(
      fail(await get(serving(() => json(doc(), { headers: { 'content-type': 'text/html' } })))),
    ).toBe('content_type');
    expect(fail(await get(serving(() => json(doc(), { headers: {} }))))).toBe('content_type');
  });

  it('refuses a client_id that differs from the URL, or is missing', async () => {
    for (const over of [
      { client_id: 'https://other.example/m.json' },
      { client_id: `${URL_OK}/` },
      { client_id: undefined },
      { client_id: 7 },
    ])
      expect(fail(await get(serving(() => json(doc(over))))), JSON.stringify(over)).toBe(
        'client_id_mismatch',
      );
  });

  it('refuses a client that wants a secret, or metadata the DCR rules refuse', async () => {
    for (const over of [
      { token_endpoint_auth_method: 'client_secret_basic' },
      { token_endpoint_auth_method: 'client_secret_post' },
      { token_endpoint_auth_method: 'private_key_jwt' },
      { client_secret: 'abc' },
      { client_secret_expires_at: 0 },
      { redirect_uris: [] },
      { redirect_uris: undefined },
      { redirect_uris: ['http://client.example/cb'] },
      { redirect_uris: ['https://client.example/cb#frag'] },
      { redirect_uris: Array.from({ length: 6 }, (_, i) => `https://client.example/cb${i}`) },
      { grant_types: ['password'] },
      { response_types: ['token'] },
      { client_name: 7 },
    ])
      expect(fail(await get(serving(() => json(doc(over))))), JSON.stringify(over)).toBe(
        'invalid_metadata',
      );
  });
});

describe.skipIf(!base)(
  'CIMD clients through /oauth/authorize and /oauth/token (needs TEST_DATABASE_URL)',
  () => {
    let t: Awaited<ReturnType<typeof testApi>>;
    const logLines: string[] = [];
    let asha: { id: string; cookie: string };
    let served: (url: string) => Response | Promise<Response>;
    let fetched: string[];
    let ipN = 0;
    const nextIp = () => `198.51.100.${(ipN = (ipN % 200) + 1)}`;

    const stub: PinnedFetch = async (url, init) => {
      fetched.push(String(url));
      if (init?.signal?.aborted) throw init.signal.reason;
      return served(String(url));
    };

    const pkce = () => {
      const verifier = randomBytes(32).toString('base64url');
      return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
    };
    const query = (clientId: string, over: Record<string, string> = {}) =>
      '/oauth/authorize?' +
      new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        state: 'st-1',
        ...over,
      }).toString();
    const get = (url: string, o: { cookie?: string; ip?: string } = {}) =>
      t.app.inject({
        method: 'GET',
        url,
        headers: { ...(o.cookie ? { cookie: o.cookie } : {}), 'x-forwarded-for': o.ip ?? nextIp() },
      });
    const post = (fields: Record<string, string>, o: { cookie?: string; ip?: string } = {}) =>
      t.app.inject({
        method: 'POST',
        url: '/oauth/authorize',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: ORIGIN,
          'x-forwarded-for': o.ip ?? nextIp(),
          ...(o.cookie ? { cookie: o.cookie } : {}),
        },
        payload: new URLSearchParams(fields).toString(),
      });
    const hidden = (html: string) => {
      const out: Record<string, string> = {};
      for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g))
        out[m[1]!] = m[2]!
          .replaceAll('&amp;', '&')
          .replaceAll('&#39;', "'")
          .replaceAll('&quot;', '"');
      return out;
    };
    const row = async (id: string) =>
      (await t.pool.query('select * from oauth_clients where client_id = $1', [id])).rows[0];

    beforeAll(async () => {
      t = await testApi(
        'woo_oauth_cimd_test',
        {},
        { level: 'info', stream: { write: (s: string) => void logLines.push(s) } },
        {
          issuer: ORIGIN,
          jwtKey: TEST_JWT_KEY,
          resource: RESOURCE,
          cimdFetch: stub,
          cimdTimeoutMs: 200,
        },
      );
      asha = await userWithSession(t.pool, 'asha-cimd@example.com', 'member');
    });
    afterAll(() => t.close());
    const reset = () => {
      fetched = [];
      served = () => json(doc());
      logLines.length = 0;
    };

    it('fetches the document of an https client_id and shows its name and the URL host on the consent page', async () => {
      reset();
      const res = await get(query(URL_OK), { cookie: asha.cookie });
      expect(res.statusCode).toBe(200);
      expect(fetched).toEqual([URL_OK]);
      expect(res.body).toContain('Example Client');
      expect(res.body).toContain('client.example');
      expect(res.body).not.toContain('unverified, self-registered');
      expect(res.body).toContain(REDIRECT);
      expect(hidden(res.body).client_id).toBe(URL_OK);
      expect(res.headers['content-security-policy']).toContain(
        "form-action 'self' http://127.0.0.1:53682",
      );
      expect(res.headers['referrer-policy']).toBe('same-origin');
    });

    it('escapes a name that holds HTML', async () => {
      reset();
      served = () => json(doc({ client_name: '<img src=x onerror=alert(1)>' }));
      const res = await get(query(URL_OK), { cookie: asha.cookie });
      expect(res.body).not.toContain('<img src=x');
      expect(res.body).toContain('&lt;img');
    });

    it('upserts the row with metadata_url and follows later changes of the document', async () => {
      reset();
      await get(query(URL_OK), { cookie: asha.cookie });
      expect(await row(URL_OK)).toMatchObject({
        client_id: URL_OK,
        metadata_url: URL_OK,
        name: 'Example Client',
        redirect_uris: ['http://127.0.0.1/callback', 'https://client.example/cb'],
      });
      served = () => json(doc({ client_name: 'Renamed', redirect_uris: ['http://localhost/cb2'] }));
      await get(query(URL_OK, { redirect_uri: 'http://localhost:9/cb2' }), { cookie: asha.cookie });
      expect(await row(URL_OK)).toMatchObject({
        name: 'Renamed',
        redirect_uris: ['http://localhost/cb2'],
      });
      const count = await t.pool.query(
        'select count(*) as n from oauth_clients where client_id = $1',
        [URL_OK],
      );
      expect(Number(count.rows[0].n)).toBe(1);
    });

    it('with no session it redirects to /login and fetches nothing', async () => {
      reset();
      const q = query(URL_OK);
      const res = await get(q);
      expect(res.statusCode).toBe(302);
      expect(String(res.headers.location)).toBe(`/login?next=${encodeURIComponent(q)}`);
      expect(fetched).toEqual([]);
    });

    it('a POST with no session is refused and fetches nothing', async () => {
      reset();
      const res = await post({ client_id: URL_OK, redirect_uri: REDIRECT, decision: 'approve' });
      expect(res.statusCode).toBe(403);
      expect(res.headers.location).toBeUndefined();
      expect(fetched).toEqual([]);
    });

    it('a redirect_uri the document does not list is a 400 page with no Location', async () => {
      reset();
      const res = await get(query(URL_OK, { redirect_uri: 'http://127.0.0.1:1/elsewhere' }), {
        cookie: asha.cookie,
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });

    it('every failed fetch is the same 400 page with no Location, naming no cause', async () => {
      const cases: Array<[string, () => Response | Promise<Response>]> = [
        ['status', () => json(doc(), { status: 500 })],
        ['mismatch', () => json(doc({ client_id: 'https://evil.example/m.json' }))],
        ['secret', () => json(doc({ token_endpoint_auth_method: 'client_secret_basic' }))],
        ['not json', () => json('nope')],
        ['too big', () => json(JSON.stringify(doc({ client_name: 'x'.repeat(6000) })))],
        ['stall', () => new Promise<Response>(() => {})],
        [
          'blocked',
          () => {
            throw Object.assign(new Error('x'), { code: 'ERR_UPSTREAM_BLOCKED' });
          },
        ],
      ];
      for (const [name, make] of cases) {
        reset();
        served = make;
        const res = await get(query(URL_OK), { cookie: asha.cookie });
        expect(res.statusCode, name).toBe(400);
        expect(res.headers.location, name).toBeUndefined();
        expect(res.body, name).toContain('could not be loaded');
        expect(res.body, name).not.toMatch(
          /non-public|blocked|private|resolve|timeout|secret|mismatch/i,
        );
      }
    });

    it('a failed fetch does not fall back to the older row', async () => {
      reset();
      expect((await get(query(URL_OK), { cookie: asha.cookie })).statusCode).toBe(200);
      expect(await row(URL_OK)).toBeTruthy();
      served = () => json('', { status: 503 });
      const res = await get(query(URL_OK), { cookie: asha.cookie });
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });

    it('refuses an http client_id as an unknown client, and fetches nothing', async () => {
      reset();
      const res = await get(query('http://client.example/m.json'), { cookie: asha.cookie });
      expect(res.statusCode).toBe(400);
      expect(fetched).toEqual([]);
    });

    it('with the real pinned fetch, a client_id that resolves to a private address is a 400 page and no row', async () => {
      const u = 'https://client.example/ssrf-metadata.json';
      const t2 = await testApi('woo_oauth_cimd_ssrf_test', {}, false, {
        issuer: ORIGIN,
        jwtKey: TEST_JWT_KEY,
        resource: RESOURCE,
        cimdFetch: pinnedFetch({ allowInsecure: false, resolve: async () => ['10.0.0.5'] }),
      });
      try {
        const user = await userWithSession(t2.pool, 'asha-ssrf@example.com', 'member');
        for (const id of [u, 'https://127.0.0.1/m.json', 'https://169.254.169.254/latest/m.json']) {
          const res = await t2.app.inject({
            method: 'GET',
            url: query(id),
            headers: { cookie: user.cookie, 'x-forwarded-for': nextIp() },
          });
          expect(res.statusCode, id).toBe(400);
          expect(res.body, id).toContain('could not be loaded');
          const n = await t2.pool.query(
            'select count(*) as n from oauth_clients where client_id = $1',
            [id],
          );
          expect(Number(n.rows[0].n), id).toBe(0);
        }
      } finally {
        await t2.close();
      }
    });

    it('without an injected fetch the default is the pinned one: a loopback or internal client_id is blocked, not tried', async () => {
      const lines: string[] = [];
      const t3 = await testApi(
        'woo_oauth_cimd_default_test',
        {},
        { level: 'info', stream: { write: (l: string) => void lines.push(l) } },
        { issuer: ORIGIN, jwtKey: TEST_JWT_KEY, resource: RESOURCE },
      );
      try {
        const user = await userWithSession(t3.pool, 'asha-default@example.com', 'member');
        for (const id of [
          'https://127.0.0.1:1/m.json',
          'https://localhost/m.json',
          'https://169.254.169.254/latest/m.json',
          'https://control-plane.platform.svc.cluster.local/m.json',
        ]) {
          lines.length = 0;
          const res = await t3.app.inject({
            method: 'GET',
            url: query(id),
            headers: { cookie: user.cookie, 'x-forwarded-for': nextIp() },
          });
          expect(res.statusCode, id).toBe(400);
          const line = lines
            .map((l) => JSON.parse(l))
            .find((l) => l.msg === 'client metadata refused');
          expect(line?.reason, id).toBe('blocked');
        }
      } finally {
        await t3.close();
      }
    });

    it('logs the reason and the host of a refused document, never the URL or its query', async () => {
      reset();
      served = () => json(doc(), { status: 500 });
      const id = 'https://client.example/m.json?token=SECRET-IN-QUERY';
      await get(query(id), { cookie: asha.cookie });
      const line = logLines
        .map((l) => JSON.parse(l))
        .find((l) => l.msg === 'client metadata refused');
      expect(line).toMatchObject({ reason: 'status', host: 'client.example' });
      // The framework's request line carries the URL of every request, as it does for any query.
      // This line, the one this code writes, has the host and the reason only.
      expect(JSON.stringify(line)).not.toContain('SECRET-IN-QUERY');
      expect(JSON.stringify(line)).not.toContain('token=');
    });

    it('the 31st fetch from one IP in a minute is refused with 429, and another IP is not limited', async () => {
      reset();
      const ip = '203.0.113.77';
      const codes: number[] = [];
      for (let i = 0; i < 31; i++)
        codes.push((await get(query(URL_OK), { cookie: asha.cookie, ip })).statusCode);
      expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
      expect(codes[30]).toBe(429);
      expect(
        (await get(query(URL_OK), { cookie: asha.cookie, ip: '203.0.113.78' })).statusCode,
      ).toBe(200);
    });

    it('runs the whole flow: consent, approve, code, and the token endpoint accepts the CIMD client_id', async () => {
      reset();
      const { verifier, challenge } = pkce();
      const q = query(URL_OK, { code_challenge: challenge });
      const page = await get(q, { cookie: asha.cookie });
      expect(page.statusCode).toBe(200);
      const approve = await post(
        { ...hidden(page.body), decision: 'approve' },
        { cookie: asha.cookie },
      );
      expect(approve.statusCode).toBe(303);
      const to = new URL(String(approve.headers.location));
      expect(to.origin + to.pathname).toBe('http://127.0.0.1:53682/callback');
      const code = to.searchParams.get('code')!;
      expect(code).toBeTruthy();
      expect(fetched).toEqual([URL_OK, URL_OK]);

      fetched.length = 0;
      const tokenRes = await t.app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': nextIp(),
        },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: URL_OK,
          code,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }).toString(),
      });
      expect(tokenRes.statusCode).toBe(200);
      expect(fetched).toEqual([]);
      const keys = oauthKeys(TEST_JWT_KEY);
      expect(
        verifyAccessToken(tokenRes.json().access_token, {
          publicKey: keys.publicKey,
          kid: keys.kid,
          iss: ORIGIN,
          aud: RESOURCE,
        }),
      ).toMatchObject({ client_id: URL_OK, sub: asha.id });
    });

    it('the token endpoint does not fetch for a CIMD client_id it has never seen', async () => {
      reset();
      const res = await t.app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': nextIp(),
        },
        payload: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'https://never-seen.example/m.json',
          refresh_token: `urt_${randomBytes(32).toString('base64url')}`,
        }).toString(),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('invalid_client');
      expect(fetched).toEqual([]);
    });
  },
);
