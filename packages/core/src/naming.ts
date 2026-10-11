import { createHash } from 'node:crypto';

export type ServerKind = 'external' | 'store' | 'hosted' | 'system';

// SPEC 5 says {1,22}, but its own examples fx and gh are two characters long.
export const SLUG_RE = /^[a-z][a-z0-9-]{0,22}[a-z0-9]$/;
// Leaves room for client prefixes such as mcp__<server>__ inside the common 64 character limit.
export const MAX_EXPOSED_NAME = 48;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.includes('__');
}

export function sanitizeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/gu, '_');
}

export function exposedToolName(slug: string, tool: string): string {
  if (!isValidSlug(slug)) throw new Error(`invalid slug: ${slug}`);
  const part = sanitizeToolName(tool);
  const full = `${slug}__${part}`;
  if (full.length <= MAX_EXPOSED_NAME) return full;
  const suffix = `_${createHash('sha256').update(tool).digest('hex').slice(0, 6)}`;
  return `${slug}__${part.slice(0, MAX_EXPOSED_NAME - slug.length - 2 - suffix.length)}${suffix}`;
}

export function describeTool(server: { kind: ServerKind; name: string }, description = ''): string {
  const prefix = server.kind === 'store' ? `[Store: ${server.name}] ` : `[${server.name}] `;
  return prefix + description;
}
