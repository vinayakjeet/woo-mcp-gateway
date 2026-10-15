import { describe, expect, it, vi } from 'vitest';
import {
  Frankfurter,
  FxError,
  MAX_CACHE_ENTRIES,
  STALE_COOLDOWN_MS,
  formatAge,
} from './frankfurter.js';

type Fetch = typeof globalThis.fetch;

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const eurUsd = { amount: 1, base: 'EUR', date: '2026-10-09', rates: { USD: 1.1206 } };
const eurTable = { amount: 1, base: 'EUR', date: '2026-10-09', rates: { INR: 98.56, USD: 1.12 } };
const currencies = { EUR: 'Euro', INR: 'Indian Rupee', USD: 'US Dollar' };
const HOUR = 3_600_000;

// A fake API whose answer can be switched to a network error or an HTTP status.
function api() {
  const state: { mode: 'ok' | 'throw' | number; rates: unknown } = { mode: 'ok', rates: eurUsd };
  const fetch = vi.fn<Fetch>(async (input) => {
    if (state.mode === 'throw') throw new TypeError('fetch failed');
    if (typeof state.mode === 'number') return json({ message: 'nope' }, state.mode);
    const url = String(input);
    if (url.includes('/currencies')) return json(currencies);
    if (url.includes('/latest?base=EUR') && !url.includes('symbols')) return json(eurTable);
    return json(state.rates);
  });
  return { state, fetch };
}

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
    expect(await fx.rates('EUR', ['USD'])).toEqual({ value: eurUsd, stale: false, ageSeconds: 0 });
    t = 59 * 60_000;
    expect(await fx.rates('EUR', ['USD'])).toEqual({
      value: eurUsd,
      stale: false,
      ageSeconds: 59 * 60,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
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
});

describe('Frankfurter outages', () => {
  it('serves the cached entry with stale true and its age when the fetch throws', async () => {
    let t = 0;
    const { state, fetch } = api();
    const fx = new Frankfurter({ fetch, now: () => t });
    await fx.rates('EUR', ['USD']);
    t = 2 * HOUR;
    state.mode = 'throw';
    expect(await fx.rates('EUR', ['USD'])).toEqual({
      value: eurUsd,
      stale: true,
      ageSeconds: 7200,
    });
  });

  it.each([500, 503, 429])('serves stale on %i', async (status) => {
    let t = 0;
    const { state, fetch } = api();
    const fx = new Frankfurter({ fetch, now: () => t });
    await fx.rates('EUR', ['USD']);
    t = 2 * HOUR;
    state.mode = status;
    expect(await fx.rates('EUR', ['USD'])).toMatchObject({ stale: true, value: eurUsd });
  });

  it.each([404, 422])('a %i stays an error even with a cache', async (status) => {
    let t = 0;
    const { state, fetch } = api();
    const fx = new Frankfurter({ fetch, now: () => t });
    await fx.rates('EUR', ['USD']);
    t = 2 * HOUR;
    state.mode = status;
    await expect(fx.rates('EUR', ['USD'])).rejects.toMatchObject({ code: `fx_http_${status}` });
  });

  it('with no cache an outage is fx_unreachable saying no cached rates exist', async () => {
    const { state, fetch } = api();
    state.mode = 'throw';
    const fx = new Frankfurter({ fetch });
    await expect(fx.rates('EUR', ['USD'])).rejects.toMatchObject({
      code: 'fx_unreachable',
      message: 'Frankfurter is unreachable and no cached rates exist',
    });
    await expect(fx.currencies()).rejects.toMatchObject({ code: 'fx_unreachable' });
  });

  it('does not call the API for 60 s after an outage error, and calls it again after', async () => {
    let t = 0;
    const { state, fetch } = api();
    const fx = new Frankfurter({ fetch, now: () => t });
    await fx.rates('EUR', ['USD']);
    t = 2 * HOUR;
    state.mode = 'throw';
    await fx.rates('EUR', ['USD']);
    expect(fetch).toHaveBeenCalledTimes(2);
    t += STALE_COOLDOWN_MS - 1000;
    expect(await fx.rates('EUR', ['USD'])).toMatchObject({ stale: true });
    await expect(fx.rates('EUR', ['INR'])).rejects.toMatchObject({ code: 'fx_unreachable' });
    expect(fetch).toHaveBeenCalledTimes(2);
    t += 2000;
    await fx.rates('EUR', ['USD']);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('a fresh answer after recovery has stale false', async () => {
    let t = 0;
    const { state, fetch } = api();
    const fx = new Frankfurter({ fetch, now: () => t });
    await fx.rates('EUR', ['USD']);
    t = 2 * HOUR;
    state.mode = 'throw';
    expect(await fx.rates('EUR', ['USD'])).toMatchObject({ stale: true });
    t += STALE_COOLDOWN_MS + 1;
    state.mode = 'ok';
    expect(await fx.rates('EUR', ['USD'])).toEqual({ value: eurUsd, stale: false, ageSeconds: 0 });
  });

  it('keeps at most 256 entries and drops the oldest fetch', async () => {
    let t = 0;
    const { state, fetch } = api();
    const fx = new Frankfurter({ fetch, now: () => t });
    expect(MAX_CACHE_ENTRIES).toBe(256);
    for (let i = 0; i <= MAX_CACHE_ENTRIES; i++) {
      t = i;
      await fx.rates('EUR', [`X${i}`]);
    }
    t = 2 * HOUR;
    state.mode = 'throw';
    await expect(fx.rates('EUR', ['X0'])).rejects.toMatchObject({ code: 'fx_unreachable' });
    expect(await fx.rates('EUR', ['X1'])).toMatchObject({ stale: true });
    expect(await fx.rates('EUR', [`X${MAX_CACHE_ENTRIES}`])).toMatchObject({ stale: true });
  });

  it('entries past the TTL are refetched, not served, while the API answers', async () => {
    let t = 0;
    const { state, fetch } = api();
    const fx = new Frankfurter({ fetch, now: () => t });
    await fx.rates('EUR', ['USD']);
    t = HOUR + 60_000;
    const next = { ...eurUsd, date: '2026-10-10', rates: { USD: 1.13 } };
    state.rates = next;
    expect(await fx.rates('EUR', ['USD'])).toEqual({ value: next, stale: false, ageSeconds: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('derives USD to INR from a cached full EUR table when that pair was never fetched', async () => {
    let t = 0;
    const { state, fetch } = api();
    const fx = new Frankfurter({ fetch, now: () => t });
    await fx.warm();
    t = 10 * 60_000;
    state.mode = 'throw';
    expect(await fx.rates('USD', ['INR'])).toEqual({
      value: { amount: 1, base: 'USD', date: '2026-10-09', rates: { INR: 88 } },
      stale: true,
      ageSeconds: 600,
    });
  });

  it('derives get_rates for base USD from the EUR table', async () => {
    let t = 0;
    const { state, fetch } = api();
    const fx = new Frankfurter({ fetch, now: () => t });
    await fx.warm();
    t = 2 * HOUR;
    state.mode = 503;
    expect(await fx.rates('USD')).toEqual({
      value: { amount: 1, base: 'USD', date: '2026-10-09', rates: { EUR: 0.892857, INR: 88 } },
      stale: true,
      ageSeconds: 7200,
    });
    await expect(fx.rates('USD', ['XYZ'])).rejects.toMatchObject({ code: 'fx_unreachable' });
  });

  it('a dated query is never derived from latest', async () => {
    const { state, fetch } = api();
    const fx = new Frankfurter({ fetch });
    await fx.warm();
    state.mode = 'throw';
    await expect(fx.rates('USD', ['INR'], '2026-10-01')).rejects.toMatchObject({
      code: 'fx_unreachable',
    });
  });

  it('warm loads latest and currencies and swallows a failure', async () => {
    const { state, fetch } = api();
    const fx = new Frankfurter({ baseUrl: 'https://fx.test/v1', fetch });
    await fx.warm();
    expect(fetch.mock.calls.map((c) => String(c[0])).sort()).toEqual([
      'https://fx.test/v1/currencies',
      'https://fx.test/v1/latest?base=EUR',
    ]);
    const down = new Frankfurter({ fetch });
    state.mode = 'throw';
    const log = vi.fn();
    await expect(down.warm(log)).resolves.toBeUndefined();
    expect(log.mock.calls).toEqual([['fx_unreachable'], ['fx_unreachable']]);
  });

  it('formatAge says minutes, hours or days', () => {
    expect([0, 59, 60, 150, 3599, 3600, 7300, 86_399, 86_400, 3 * 86_400].map(formatAge)).toEqual([
      'less than a minute',
      'less than a minute',
      '1 minute',
      '2 minutes',
      '59 minutes',
      '1 hour',
      '2 hours',
      '23 hours',
      '1 day',
      '3 days',
    ]);
  });
});
