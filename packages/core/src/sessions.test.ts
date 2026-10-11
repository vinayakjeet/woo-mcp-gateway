import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SESSION_TTL_MS,
  generateSessionToken,
  sessionCookie,
  sessionExpiresAt,
} from './sessions.js';

describe('session tokens', () => {
  it('stores only the sha256 of 32 random bytes', () => {
    const { token, tokenHash } = generateSessionToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
  });
  it('expires 12 hours later', () => {
    const now = new Date('2026-10-11T00:00:00Z');
    expect(SESSION_TTL_MS).toBe(12 * 3600 * 1000);
    expect(sessionExpiresAt(now).toISOString()).toBe('2026-10-11T12:00:00.000Z');
  });
  it('builds the sid cookie, Secure only on https', () => {
    expect(sessionCookie('t', false)).toBe('sid=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200');
    expect(sessionCookie('t', true)).toBe(
      'sid=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure',
    );
  });
});
