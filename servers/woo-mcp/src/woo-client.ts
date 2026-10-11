import { newNonce, rfc3986, signedQuery } from './oauth.js';

export class WooError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WooError';
  }
}

export interface WpIndex {
  name: string;
  url: string;
  timezone_string?: string;
  gmt_offset?: number | string;
}

type Query = Record<string, string | number | boolean | undefined>;

export interface WooApi {
  request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    opts?: { query?: Query; body?: unknown },
  ): Promise<{ data: T; total?: number }>;
  index(): Promise<WpIndex>;
}

export interface WooConfig {
  baseUrl: string;
  signingBaseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class WooClient implements WooApi {
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly cfg: WooConfig) {
    this.fetch = cfg.fetch ?? globalThis.fetch;
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
    this.now = cfg.now ?? (() => new Date());
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ) {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined) query[k] = String(v);
    const signed = signedQuery({
      method,
      url: this.cfg.signingBaseUrl.replace(/\/$/, '') + path,
      query,
      consumerKey: this.cfg.consumerKey,
      consumerSecret: this.cfg.consumerSecret,
      nonce: newNonce(),
      timestamp: Math.floor(this.now().getTime() / 1000),
    });
    const qs = Object.entries(signed)
      .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
      .join('&');
    const init: RequestInit = { method, headers: { accept: 'application/json' } };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
      init.headers = { ...init.headers, 'content-type': 'application/json' };
    }
    const res = await this.send(`${this.cfg.baseUrl.replace(/\/$/, '')}${path}?${qs}`, init);
    const totalHeader = res.headers.get('x-wp-total');
    return {
      data: (await this.parse(res)) as T,
      total: totalHeader === null ? undefined : Number(totalHeader),
    };
  }

  async index(): Promise<WpIndex> {
    const res = await this.send(`${this.cfg.baseUrl.replace(/\/$/, '')}/wp-json/`, {
      headers: { accept: 'application/json' },
    });
    const i = (await this.parse(res)) as WpIndex;
    return {
      name: i.name,
      url: i.url,
      timezone_string: i.timezone_string,
      gmt_offset: i.gmt_offset,
    };
  }

  // Errors carry only WooCommerce's code and message: the URL holds the consumer key and signature.
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new WooError(
          'woo_timeout',
          `WooCommerce did not answer within ${this.timeoutMs} ms`,
          504,
        );
      }
      throw new WooError('woo_unreachable', 'WooCommerce is unreachable', 502);
    }
  }

  private async parse(res: Response): Promise<unknown> {
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new WooError(
        `woo_http_${res.status}`,
        `WooCommerce answered ${res.status} without JSON`,
        res.status,
      );
    }
    if (!res.ok) {
      const b = body as { code?: string; message?: string };
      throw new WooError(
        b.code ?? `woo_http_${res.status}`,
        b.message ?? `HTTP ${res.status}`,
        res.status,
      );
    }
    return body;
  }
}
