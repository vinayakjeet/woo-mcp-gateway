import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, call, testApi } from './test-app.js';

const base = process.env.TEST_DATABASE_URL;
const REG = '/oauth/register';
const ok = { redirect_uris: ['http://127.0.0.1:53682/callback'], client_name: 'Claude Code' };

describe.skipIf(!base)('POST /oauth/register (needs TEST_DATABASE_URL)', () => {
  let t: Awaited<ReturnType<typeof testApi>>;
  let n = 0;
  // A fresh forwarded address per test, so the per-IP counter of one test cannot limit the next.
  const ip = () => `203.0.113.${(n = (n % 250) + 1)}`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    call(t.app, 'POST', REG, {
      body,
      origin: null,
      headers: { 'x-forwarded-for': ip(), ...headers },
    });
  const rows = async () =>
    (
      await t.pool.query<{
        client_id: string;
        name: string;
        redirect_uris: string[];
        metadata_url: string | null;
      }>(
        'select client_id, name, redirect_uris, metadata_url from oauth_clients order by created_at',
      )
    ).rows;

  beforeAll(async () => {
    t = await testApi('woo_oauth_register_test', {}, false, { issuer: ORIGIN });
  });
  afterAll(() => t.close());

  it('a valid DCR body gets 201 with a dcr_ client_id and the echoed metadata', async () => {
    const res = await post(ok);
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b.client_id).toMatch(/^dcr_[A-Za-z0-9_-]{22}$/);
    expect(b).toMatchObject({
      client_name: 'Claude Code',
      redirect_uris: ok.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(typeof b.client_id_issued_at).toBe('number');
    expect(b.client_secret).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.pragma).toBe('no-cache');
    const row = (await rows()).find((r) => r.client_id === b.client_id);
    expect(row).toMatchObject({
      name: 'Claude Code',
      redirect_uris: ok.redirect_uris,
      metadata_url: null,
    });
  });

  it('gives every registration its own client_id', async () => {
    const a = (await post(ok)).json().client_id;
    const b = (await post(ok)).json().client_id;
    expect(a).not.toBe(b);
  });

  it('accepts one to five redirect URIs and refuses six or none', async () => {
    const uris = (k: number) =>
      Array.from({ length: k }, (_, i) => `https://client.example/cb${i}`);
    expect((await post({ redirect_uris: uris(5) })).statusCode).toBe(201);
    for (const bad of [uris(6), [], undefined, 'https://client.example/cb', {}]) {
      const res = await post({ redirect_uris: bad });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_redirect_uri');
    }
  });

  it.each([
    ['an http non-loopback redirect', 'http://client.example/cb'],
    ['a lookalike loopback host', 'http://localhost.evil.example/cb'],
    ['a fragment', 'https://client.example/cb#x'],
    ['userinfo', 'https://user:pw@client.example/cb'],
    ['a custom scheme', 'myapp://cb'],
    ['a javascript URI', 'javascript:alert(1)'],
    ['an over-long URI', `https://client.example/${'a'.repeat(2000)}`],
  ])('%s is invalid_redirect_uri', async (_n, uri) => {
    const res = await post({ ...ok, redirect_uris: [ok.redirect_uris[0], uri] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(typeof res.json().error_description).toBe('string');
  });

  it.each([
    ['client_secret_basic', { token_endpoint_auth_method: 'client_secret_basic' }],
    ['client_secret_post', { token_endpoint_auth_method: 'client_secret_post' }],
    ['private_key_jwt', { token_endpoint_auth_method: 'private_key_jwt' }],
    ['an implicit grant', { grant_types: ['implicit'] }],
    ['a password grant', { grant_types: ['authorization_code', 'password'] }],
    ['a token response type', { response_types: ['token'] }],
    ['a grant_types that is not a list', { grant_types: 'authorization_code' }],
    ['a client_name that is not a string', { client_name: { a: 1 } }],
  ])('%s is invalid_client_metadata', async (_n, extra) => {
    const res = await post({ ...ok, ...extra });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_client_metadata');
  });

  it('accepts none, the two grants we issue, and code', async () => {
    const res = await post({
      ...ok,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
    expect(res.statusCode).toBe(201);
  });

  it('a body that is not an object is refused', async () => {
    for (const body of [[], 'text', 5, null]) {
      const res = await post(body);
      expect(res.statusCode).toBe(400);
    }
  });

  it('a name with control characters is cleaned and capped at 100', async () => {
    const res = await post({ ...ok, client_name: `Evil\n‮App${'x'.repeat(200)}` });
    expect(res.statusCode).toBe(201);
    const name: string = res.json().client_name;
    expect(name).toMatch(/^EvilApp/);
    expect(Array.from(name)).toHaveLength(100);
    expect(name).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it('defaults the name when it is missing', async () => {
    const res = await post({ redirect_uris: ok.redirect_uris });
    expect(res.json().client_name).toBe('Unnamed client');
  });

  it('unknown fields are not stored or echoed', async () => {
    const res = await post({
      ...ok,
      logo_uri: 'https://client.example/logo.png',
      client_uri: 'https://client.example',
      jwks_uri: 'https://client.example/jwks',
      contacts: ['a@example.com'],
      scope: 'admin everything',
      client_secret: 'chosen-by-client',
    });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    for (const k of ['logo_uri', 'client_uri', 'jwks_uri', 'contacts', 'scope', 'client_secret'])
      expect(b[k]).toBeUndefined();
    const { rows: cols } = await t.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'oauth_clients'`,
    );
    expect(JSON.stringify(cols)).not.toContain('logo');
    expect(JSON.stringify(await rows())).not.toContain('chosen-by-client');
  });

  it('malformed JSON is invalid_request, and a body over 16 KiB is refused', async () => {
    const bad = await t.app.inject({
      method: 'POST',
      url: REG,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() },
      payload: '{"redirect_uris": [',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_request');
    const big = await post({ ...ok, junk: 'x'.repeat(20_000) });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe('invalid_request');
  });

  it('POST without an Origin header, and with a foreign one, is accepted', async () => {
    expect((await post(ok)).statusCode).toBe(201);
    const foreign = await post(ok, { origin: 'http://evil.example' });
    expect(foreign.statusCode).toBe(201);
    expect(foreign.headers['access-control-allow-origin']).toBe('*');
    expect(foreign.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not read a session cookie', async () => {
    const res = await post(ok, { cookie: 'sid=not-a-real-session' });
    expect(res.statusCode).toBe(201);
  });

  it('OPTIONS answers the CORS preflight', async () => {
    const res = await t.app.inject({
      method: 'OPTIONS',
      url: REG,
      headers: {
        origin: 'http://localhost:6274',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('content-type');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('the 11th registration from one IP in a minute is 429, and another IP is not limited', async () => {
    const h = { 'x-forwarded-for': '198.51.100.7' };
    for (let i = 0; i < 10; i++) {
      const res = await call(t.app, 'POST', REG, { body: ok, origin: null, headers: h });
      expect(res.statusCode).toBe(201);
    }
    const limited = await call(t.app, 'POST', REG, { body: ok, origin: null, headers: h });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'temporarily_unavailable' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['access-control-allow-origin']).toBe('*');
    const other = await call(t.app, 'POST', REG, {
      body: ok,
      origin: null,
      headers: { 'x-forwarded-for': '198.51.100.8' },
    });
    expect(other.statusCode).toBe(201);
  });

  it('a limited request registers nothing', async () => {
    const before = (await rows()).length;
    const h = { 'x-forwarded-for': '198.51.100.9' };
    for (let i = 0; i < 12; i++)
      await call(t.app, 'POST', REG, { body: ok, origin: null, headers: h });
    expect((await rows()).length - before).toBe(10);
  });
});
