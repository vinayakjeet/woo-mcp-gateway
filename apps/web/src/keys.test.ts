import { describe, expect, it } from 'vitest';
import { keyStatus, parseLimit } from './keys';

const now = Date.parse('2026-10-12T10:00:00Z');

describe('keyStatus', () => {
  it.each([
    [{ revokedAt: null, expiresAt: null }, 'active'],
    [{ revokedAt: '2026-10-11T00:00:00Z', expiresAt: null }, 'revoked'],
    [{ revokedAt: null, expiresAt: '2026-10-12T09:59:59Z' }, 'expired'],
    [{ revokedAt: null, expiresAt: '2026-10-13T00:00:00Z' }, 'active'],
  ])('%j is %s', (k, want) => expect(keyStatus(k, now)).toBe(want));
});

describe('parseLimit', () => {
  it('accepts whole numbers from 1 to 10000 and nothing else', () => {
    expect(parseLimit('5')).toBe(5);
    expect(parseLimit(' 10000 ')).toBe(10000);
    for (const bad of ['', '0', '-1', '10001', '1.5', 'abc', '5e2', '1 2']) {
      expect(parseLimit(bad), bad).toBeNull();
    }
  });
});
