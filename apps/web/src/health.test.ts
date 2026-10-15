import { describe, expect, it } from 'vitest';
import { formatMs, formatPerMinute, formatRate, healthPill } from './health';

describe('formatRate', () => {
  it('shows percents with one decimal and null as a dash', () => {
    expect(formatRate(0)).toBe('0.0%');
    expect(formatRate(0.1234)).toBe('12.3%');
    expect(formatRate(0.5)).toBe('50.0%');
    expect(formatRate(1)).toBe('100.0%');
    expect(formatRate(4 / 6)).toBe('66.7%');
    expect(formatRate(null)).toBe('-');
  });
});

describe('formatMs', () => {
  it('rounds to whole milliseconds and shows null as a dash', () => {
    expect(formatMs(550)).toBe('550 ms');
    expect(formatMs(954.6)).toBe('955 ms');
    expect(formatMs(0.2)).toBe('0 ms');
    expect(formatMs(15000)).toBe('15000 ms');
    expect(formatMs(null)).toBe('-');
  });
});

describe('formatPerMinute', () => {
  it('shows two decimals below 10 and whole numbers from 10', () => {
    expect(formatPerMinute(0)).toBe('0.00');
    expect(formatPerMinute(14 / 60)).toBe('0.23');
    expect(formatPerMinute(9.99)).toBe('9.99');
    expect(formatPerMinute(10)).toBe('10');
    expect(formatPerMinute(42.4)).toBe('42');
  });
});

describe('healthPill', () => {
  const base = { enabled: true, approval: 'approved' as const, state: null };
  it('uses the same pills as the Servers page', () => {
    expect(healthPill({ ...base, state: 'connected' })).toEqual({ label: 'Connected', tone: 'ok' });
    expect(healthPill({ ...base, state: 'unreachable' })).toEqual({
      label: 'Unreachable',
      tone: 'bad',
    });
    expect(healthPill({ ...base, state: null })).toEqual({ label: 'Checking', tone: 'idle' });
    expect(healthPill({ ...base, enabled: false, state: 'connected' })).toEqual({
      label: 'Disabled',
      tone: 'off',
    });
    expect(healthPill({ ...base, approval: 'pending', state: 'connected' })).toEqual({
      label: 'Pending approval',
      tone: 'warn',
    });
  });
});
