import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, call, testApi } from './test-app.js';

const base = process.env.TEST_DATABASE_URL;
const META = '/.well-known/oauth-authorization-server';

describe.skipIf(!base)('OAuth authorization server metadata (needs TEST_DATABASE_URL)', () => {
  let on: Awaited<ReturnType<typeof testApi>>;
  let off: Awaited<ReturnType<typeof testApi>>;

  beforeAll(async () => {
    on = await testApi('woo_oauth_meta_on_test', {}, false, { issuer: ORIGIN });
    off = await testApi('woo_oauth_meta_off_test');
  });
  afterAll(async () => {
    await on.close();
    await off.close();
  });

  it('fields match decision 4 and code_challenge_methods_supported is exactly S256', async () => {
    const res = await call(on.app, 'GET', META);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      scopes_supported: ['mcp:tools'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
  });

  it('advertises Client ID Metadata Documents, as the boolean true', async () => {
    const body = (await call(on.app, 'GET', META)).json();
    expect(body.client_id_metadata_document_supported).toBe(true);
  });

  it('answers a foreign Origin with Access-Control-Allow-Origin * and no credentials', async () => {
    const res = await call(on.app, 'GET', META, { headers: { origin: 'http://localhost:6274' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers the CORS preflight', async () => {
    const res = await on.app.inject({
      method: 'OPTIONS',
      url: META,
      headers: { origin: 'http://localhost:6274', 'access-control-request-method': 'GET' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('is public: it needs no cookie and sets none', async () => {
    const res = await call(on.app, 'GET', META);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('with oauth off every /oauth path and the metadata are 404', async () => {
    for (const url of [META, '/oauth/register', '/oauth/authorize', '/oauth/token']) {
      expect((await call(off.app, 'GET', url)).statusCode).toBe(404);
    }
    expect((await call(off.app, 'POST', '/oauth/register', { body: {} })).statusCode).toBe(404);
    expect((await call(off.app, 'POST', '/oauth/token', { body: {} })).statusCode).toBe(404);
    const pre = await off.app.inject({ method: 'OPTIONS', url: META });
    expect(pre.statusCode).toBe(404);
  });

  it('with oauth off POST /oauth/register without an Origin is still the Origin check (unchanged)', async () => {
    const res = await call(off.app, 'POST', '/oauth/register', { body: {}, origin: null });
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/keys and /api/auth/login without an Origin are still 403 with oauth on', async () => {
    for (const url of ['/api/keys', '/api/auth/login']) {
      const res = await call(on.app, 'POST', url, {
        body: { email: 'a@b.co', password: 'x' },
        origin: null,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'bad_origin' });
    }
    const foreign = await call(on.app, 'POST', '/api/keys', {
      body: {},
      origin: 'http://evil.example',
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('the exemption covers only register and token, not neighbours or a longer path', async () => {
    for (const url of [
      '/oauth/register/x',
      '/oauth/registerx',
      '/oauth/authorize',
      '/oauth/',
      '/oauth',
    ]) {
      const res = await call(on.app, 'POST', url, { body: {}, origin: null });
      expect(res.statusCode).toBe(403);
    }
    // A query string does not move a path out of the exemption or into it.
    expect(
      (await call(on.app, 'POST', '/api/keys?x=/oauth/register', { body: {}, origin: null }))
        .statusCode,
    ).toBe(403);
  });
});
