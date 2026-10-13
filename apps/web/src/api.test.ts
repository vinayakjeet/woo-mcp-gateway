import { describe, expect, it } from 'vitest';
import { api, ApiError } from './api';

function fakeFetch(status: number, body: string | null) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('api', () => {
  it('sends JSON with a content type only when there is a body', async () => {
    const { f, calls } = fakeFetch(200, '{"ok":1}');
    expect(await api('/api/keys', { method: 'POST', body: { name: 'x' } }, f)).toEqual({ ok: 1 });
    expect(calls[0]!.init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"x"}',
    });
    await api('/api/keys/1', { method: 'DELETE' }, f);
    expect(calls[1]!.init.headers).toEqual({});
    expect(calls[1]!.init.body).toBeUndefined();
  });
  it('returns undefined for 204', async () => {
    expect(
      await api('/api/auth/logout', { method: 'POST' }, fakeFetch(204, null).f),
    ).toBeUndefined();
  });
  it('throws ApiError with the status and the error code', async () => {
    const err = await api<never>(
      '/api/me',
      {},
      fakeFetch(401, '{"error":"unauthenticated"}').f,
    ).catch((e: unknown) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect([err.status, err.code]).toEqual([401, 'unauthenticated']);
  });
  it('copes with an error body that is not JSON', async () => {
    const err = await api<never>('/api/me', {}, fakeFetch(502, '<html>bad gateway</html>').f).catch(
      (e: unknown) => e as ApiError,
    );
    expect([err.status, err.code]).toEqual([502, 'http_error']);
  });
  it('sends extra headers with the JSON content type', async () => {
    const { f, calls } = fakeFetch(202, '{"store":{}}');
    await api(
      '/api/stores',
      { method: 'POST', body: { name: 'x' }, headers: { 'idempotency-key': 'k1' } },
      f,
    );
    expect(calls[0]!.init.headers).toEqual({
      'idempotency-key': 'k1',
      'content-type': 'application/json',
    });
  });
});
