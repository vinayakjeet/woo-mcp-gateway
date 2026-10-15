export class FxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FxError';
  }
}

type Rates = { amount?: number; base: string; date: string; rates: Record<string, number> };
export type Fetched<T> = { value: T; stale: boolean; ageSeconds: number };

// After an outage error, answer from cache without calling Frankfurter, so an
// outage costs one 10 s timeout per minute instead of one per call.
export const STALE_COOLDOWN_MS = 60_000;
export const MAX_CACHE_ENTRIES = 256;
// The full EUR table that warm() loads; any latest pair can be derived from it.
const EUR_TABLE = '/latest?base=EUR';

export function formatAge(seconds: number): string {
  if (seconds < 60) return 'less than a minute';
  const [n, unit] =
    seconds < 3600
      ? [Math.floor(seconds / 60), 'minute']
      : seconds < 86_400
        ? [Math.floor(seconds / 3600), 'hour']
        : [Math.floor(seconds / 86_400), 'day'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

export class Frankfurter {
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  // Map order is fetch order (an entry is re-inserted on refetch), so the first key is the oldest.
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private outageUntil = 0;

  constructor(
    opts: {
      baseUrl?: string;
      fetch?: typeof globalThis.fetch;
      now?: () => number;
      ttlMs?: number;
      timeoutMs?: number;
    } = {},
  ) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.frankfurter.dev/v1').replace(/\/$/, '');
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  rates(base: string, symbols?: string[], date?: string): Promise<Fetched<Rates>> {
    const q = new URLSearchParams({ base });
    if (symbols?.length) q.set('symbols', symbols.join(','));
    // A dated answer cannot come from the latest table.
    const derive = date ? undefined : () => this.derive(base, symbols);
    return this.get<Rates>(`/${date ?? 'latest'}?${q}`, derive);
  }

  currencies(): Promise<Fetched<Record<string, string>>> {
    return this.get('/currencies');
  }

  // Readiness never waits for this: a failure is only reported through log.
  async warm(log: (code: string) => void = () => {}): Promise<void> {
    const results = await Promise.allSettled([this.rates('EUR'), this.currencies()]);
    for (const r of results)
      if (r.status === 'rejected')
        log(r.reason instanceof FxError ? r.reason.code : 'internal_error');
  }

  private async get<T>(path: string, derive?: () => Fetched<T> | null): Promise<Fetched<T>> {
    const hit = this.cache.get(path);
    if (hit && this.now() - hit.at < this.ttlMs)
      return { value: hit.value as T, stale: false, ageSeconds: this.age(hit.at) };
    if (this.now() < this.outageUntil) return this.fromCache(path, derive);
    let res: Response;
    try {
      res = await this.fetch(this.baseUrl + path, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      return this.outage(path, derive);
    }
    // Other 4xx answers (bad date, unknown currency) are real answers, not outages.
    if (res.status >= 500 || res.status === 429) return this.outage(path, derive);
    if (!res.ok) throw new FxError(`fx_http_${res.status}`, `Frankfurter answered ${res.status}`);
    const value = (await res.json()) as T;
    this.cache.delete(path);
    this.cache.set(path, { at: this.now(), value });
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return { value, stale: false, ageSeconds: 0 };
  }

  private outage<T>(path: string, derive?: () => Fetched<T> | null): Fetched<T> {
    this.outageUntil = this.now() + STALE_COOLDOWN_MS;
    return this.fromCache(path, derive);
  }

  private fromCache<T>(path: string, derive?: () => Fetched<T> | null): Fetched<T> {
    const hit = this.cache.get(path);
    if (hit) return { value: hit.value as T, stale: true, ageSeconds: this.age(hit.at) };
    const derived = derive?.();
    if (derived) return derived;
    throw new FxError('fx_unreachable', 'Frankfurter is unreachable and no cached rates exist');
  }

  private derive(base: string, symbols?: string[]): Fetched<Rates> | null {
    const hit = this.cache.get(EUR_TABLE);
    if (!hit) return null;
    const table = hit.value as Rates;
    const perEur: Record<string, number> = { ...table.rates, EUR: 1 };
    const from = perEur[base];
    if (from === undefined) return null;
    const codes = symbols?.length
      ? symbols
      : Object.keys(perEur)
          .filter((c) => c !== base)
          .sort();
    const rates: Record<string, number> = {};
    for (const c of codes) {
      const to = perEur[c];
      if (to === undefined) return null;
      // Division adds float noise (0.7589285714285714); six significant digits is more than the ECB publishes.
      rates[c] = Number((to / from).toPrecision(6));
    }
    return {
      value: { amount: 1, base, date: table.date, rates },
      stale: true,
      ageSeconds: this.age(hit.at),
    };
  }

  private age(at: number): number {
    return Math.floor((this.now() - at) / 1000);
  }
}
