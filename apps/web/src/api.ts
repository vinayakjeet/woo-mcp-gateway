export type ApiIssue = { path: string; message: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly issues: ApiIssue[] = [],
  ) {
    super(code);
  }
}

type Init = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
};

export async function api<T>(path: string, init: Init = {}, f: typeof fetch = fetch): Promise<T> {
  // A DELETE or a logout has no body and must not claim JSON: Fastify rejects an empty JSON body.
  const headers: Record<string, string> = {
    ...init.headers,
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  const r = await f(path, {
    method: init.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (r.status === 204) return undefined as T;
  const data = (await r.json().catch(() => ({}))) as { error?: unknown; issues?: unknown };
  if (!r.ok) {
    throw new ApiError(
      r.status,
      typeof data.error === 'string' ? data.error : 'http_error',
      apiIssues(data.issues),
    );
  }
  return data as T;
}

function apiIssues(v: unknown): ApiIssue[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((i: unknown) => {
    const o = i as { path?: unknown; message?: unknown } | null;
    return typeof o?.path === 'string' && typeof o.message === 'string'
      ? [{ path: o.path, message: o.message }]
      : [];
  });
}
