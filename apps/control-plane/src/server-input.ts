import { isValidSlug } from '@woo/core';
import { z } from 'zod';

// An upstream auth header with one of these names would break HTTP framing or the MCP transport.
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
]);
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

const headerName = z
  .string()
  .regex(HEADER_TOKEN)
  .refine((h) => !RESERVED_HEADERS.has(h.toLowerCase()));
const secret = z.string().min(1).max(4096);
const url = z
  .string()
  .max(2048)
  .refine((u) => {
    try {
      const p = new URL(u).protocol;
      return p === 'http:' || p === 'https:';
    } catch {
      return false;
    }
  });

export const authInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('bearer'), secret: secret.optional() }).strict(),
  z.object({ type: z.literal('header'), headerName, secret: secret.optional() }).strict(),
]);

const name = z.string().trim().min(1).max(100);
const timeoutMs = z.number().int().min(1000).max(60000);
const protocolMode = z.enum(['legacy', 'auto']);

const createServerInput = z
  .object({
    name,
    slug: z.string(),
    url,
    auth: authInput,
    timeoutMs: timeoutMs.default(15000),
    protocolMode: protocolMode.default('legacy'),
  })
  .strict();

const patchServerInput = z
  .object({
    name: name.optional(),
    url: url.optional(),
    auth: authInput.optional(),
    timeoutMs: timeoutMs.optional(),
    protocolMode: protocolMode.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type AuthInput = z.infer<typeof authInput>;
export type CreateServerInput = z.infer<typeof createServerInput>;
export type PatchServerInput = z.infer<typeof patchServerInput>;
export type InputError = 'bad_request' | 'invalid_slug' | 'slug_immutable' | 'secret_required';
type Parsed<T> = { ok: true; value: T } | { ok: false; error: InputError };

export function parseCreate(body: unknown): Parsed<CreateServerInput> {
  const p = createServerInput.safeParse(body);
  if (!p.success) return { ok: false, error: 'bad_request' };
  if (!isValidSlug(p.data.slug)) return { ok: false, error: 'invalid_slug' };
  if (p.data.auth.type !== 'none' && !p.data.auth.secret) {
    return { ok: false, error: 'secret_required' };
  }
  return { ok: true, value: p.data };
}

export function parsePatch(body: unknown): Parsed<PatchServerInput> {
  // Named separately so the UI can say why: renaming a slug renames tools under connected clients.
  if (body !== null && typeof body === 'object' && 'slug' in body) {
    return { ok: false, error: 'slug_immutable' };
  }
  const p = patchServerInput.safeParse(body);
  if (!p.success || Object.keys(p.data).length === 0) return { ok: false, error: 'bad_request' };
  return { ok: true, value: p.data };
}

// The stored secret after a change: undefined keeps it, null clears it, a string replaces it.
export function nextSecret(auth: AuthInput | undefined): string | null | undefined {
  if (!auth) return undefined;
  if (auth.type === 'none') return null;
  return auth.secret;
}
