import type { FastifyRequest } from 'fastify';

export type Fields = Record<string, unknown>;

const MAX_FIELDS = 40;

// undefined: not sent. null: sent more than once or not as text, which is never valid.
export const one = (f: Fields, k: string): string | undefined | null => {
  const v = f[k];
  return v === undefined ? undefined : typeof v === 'string' ? v : null;
};

// A key that repeats becomes a list, so `one` can refuse it. The object has no prototype, so a
// field named __proto__ is only a field.
export function parseForm(raw: string): Fields | null {
  const out: Fields = Object.create(null) as Fields;
  let count = 0;
  for (const [k, v] of new URLSearchParams(raw)) {
    if (++count > MAX_FIELDS) return null;
    out[k] = k in out ? [out[k]] : v;
  }
  return out;
}

export const isForm = (req: FastifyRequest): boolean =>
  (req.headers['content-type'] ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded');
