import { describe, expect, it, vi } from 'vitest';
import { Frankfurter, FxError } from './frankfurter.js';

type Fetch = typeof globalThis.fetch;

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const eurUsd = { amount: 1, base: 'EUR', date: '2026-10-09', rates: { USD: 1.1206 } };

describe('Frankfurter', () => {
  it('builds latest and dated URLs with symbols', async () => {
    const fetch = vi.fn<Fetch>(async () => json(eurUsd));
    const fx = new Frankfurter({ baseUrl: 'https://fx.test/v1', fetch });
    await fx.rates('EUR', ['USD', 'INR']);
    await fx.rates('EUR', undefined, '2026-01-02');
    expect(fetch.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://fx.test/v1/latest?base=EUR&symbols=USD%2CINR',
      'https://fx.test/v1/2026-01-02?base=EUR',
    ]);
  });

  it('caches for one hour', async () => {
    let t = 0;
    const fetch = vi.fn<Fetch>(async () => json(eurUsd));
    const fx = new Frankfurter({ fetch, now: () => t });
    await fx.rates('EUR', ['USD']);
    t = 59 * 60_000;
    await fx.rates('EUR', ['USD']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fx.cacheAgeSeconds()).toBe(59 * 60);
    t = 61 * 60_000;
    await fx.rates('EUR', ['USD']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures and maps them to FxError', async () => {
    const fetch = vi.fn<Fetch>(async () => json({ message: 'not found' }, 404));
    const fx = new Frankfurter({ fetch });
    await expect(fx.rates('EUR')).rejects.toBeInstanceOf(FxError);
    await expect(fx.rates('EUR')).rejects.toMatchObject({ code: 'fx_http_404' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('maps network errors to fx_unreachable', async () => {
    const fx = new Frankfurter({
      fetch: vi.fn<Fetch>(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    await expect(fx.rates('EUR')).rejects.toMatchObject({ code: 'fx_unreachable' });
  });

  it('cacheAgeSeconds is null before any call', () => {
    expect(new Frankfurter({ fetch: vi.fn<Fetch>() }).cacheAgeSeconds()).toBeNull();
  });
});
