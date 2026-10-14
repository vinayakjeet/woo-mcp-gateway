import { isValidSlug } from '@woo/core';
import { z } from 'zod';

// SPEC 18: main belongs to the store that make store installs, which the platform adopts.
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(['main']);
export const DEADLINE_MINUTES = 15;

const MAX_NAME = 60;
const KEY_RE = /^[\x21-\x7e]{1,200}$/;

// SPEC 18: lowercase, hyphens, 3 to 20 characters. The slug also names the namespace, the release,
// the store host and the MCP server, so it must pass the shared slug rule as well.
export function deriveStoreSlug(name: string): string | null {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 20)
    .replace(/-+$/, '');
  return slug.length >= 3 && isValidSlug(slug) ? slug : null;
}

const createBody = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_NAME)
    .refine((s) => !/\p{Cc}/u.test(s)),
});

export type StoreCreate = { name: string; slug: string };

export function parseStoreCreate(
  body: unknown,
): { ok: true; value: StoreCreate } | { ok: false; error: 'invalid_name' | 'slug_reserved' } {
  const p = createBody.safeParse(body);
  if (!p.success) return { ok: false, error: 'invalid_name' };
  const slug = deriveStoreSlug(p.data.name);
  if (!slug) return { ok: false, error: 'invalid_name' };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: 'slug_reserved' };
  return { ok: true, value: { name: p.data.name, slug } };
}

export function parseIdempotencyKey(
  h: string | string[] | undefined,
): { ok: true; key: string | null } | { ok: false } {
  if (h === undefined) return { ok: true, key: null };
  if (typeof h !== 'string' || !KEY_RE.test(h)) return { ok: false };
  return { ok: true, key: h };
}
