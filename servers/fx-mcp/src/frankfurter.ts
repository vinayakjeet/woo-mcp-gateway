export class FxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FxError';
  }
}

type Rates = { base: string; date: string; rates: Record<string, number> };

export class Frankfurter {
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private lastFetchAt: number | null = null;

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

  rates(base: string, symbols?: string[], date?: string): Promise<Rates> {
    const q = new URLSearchParams({ base });
    if (symbols?.length) q.set('symbols', symbols.join(','));
    return this.get<Rates>(`/${date ?? 'latest'}?${q}`);
  }

  currencies(): Promise<Record<string, string>> {
    return this.get('/currencies');
  }

  cacheAgeSeconds(): number | null {
    return this.lastFetchAt === null ? null : Math.floor((this.now() - this.lastFetchAt) / 1000);
  }

  private async get<T>(path: string): Promise<T> {
    const hit = this.cache.get(path);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value as T;
    let res: Response;
    try {
      res = await this.fetch(this.baseUrl + path, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new FxError('fx_unreachable', 'Frankfurter is unreachable');
    }
    if (!res.ok) throw new FxError(`fx_http_${res.status}`, `Frankfurter answered ${res.status}`);
    const value = (await res.json()) as T;
    const at = this.now();
    this.cache.set(path, { at, value });
    this.lastFetchAt = at;
    return value;
  }
}
