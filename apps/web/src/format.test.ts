import { describe, expect, it } from 'vitest';
import { ago, formatTs } from './format';

describe('format', () => {
  it('formats API timestamps, including audit ones with microseconds', () => {
    expect(formatTs('2026-10-12T10:00:00.123Z', 'UTC')).toBe('2026-10-12 10:00:00');
    expect(formatTs('2026-10-12T10:00:00.123456Z', 'UTC')).toBe('2026-10-12 10:00:00');
  });
  it('says how long ago', () => {
    const now = Date.parse('2026-10-12T10:00:00Z');
    expect(ago('2026-10-12T09:59:55Z', now)).toBe('5 s ago');
    expect(ago('2026-10-12T09:58:00Z', now)).toBe('2 min ago');
    expect(ago('2026-10-12T07:00:00Z', now)).toBe('3 h ago');
    expect(ago('2026-10-10T10:00:00Z', now)).toBe('2 d ago');
    expect(ago('2026-10-12T10:00:05Z', now)).toBe('0 s ago');
  });
});
