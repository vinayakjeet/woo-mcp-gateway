import { describe, expect, it } from 'vitest';
import { keyStatus } from './keys';

const now = Date.parse('2026-10-12T10:00:00Z');

describe('keyStatus', () => {
  it.each([
    [{ revokedAt: null, expiresAt: null }, 'active'],
    [{ revokedAt: '2026-10-11T00:00:00Z', expiresAt: null }, 'revoked'],
    [{ revokedAt: null, expiresAt: '2026-10-12T09:59:59Z' }, 'expired'],
    [{ revokedAt: null, expiresAt: '2026-10-13T00:00:00Z' }, 'active'],
  ])('%j is %s', (k, want) => expect(keyStatus(k, now)).toBe(want));
});
