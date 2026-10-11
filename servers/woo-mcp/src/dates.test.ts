import { describe, expect, it } from 'vitest';
import { resolveRange, startOfDay, storeTimeZone, toWcGmt } from './dates.js';

const iso = (d?: Date) => d?.toISOString();

describe('storeTimeZone', () => {
  it('prefers timezone_string', () => {
    expect(storeTimeZone({ timezone_string: 'Asia/Kolkata', gmt_offset: 5.5 })).toBe('Asia/Kolkata');
  });
  it('falls back to gmt_offset, including half hours and negatives', () => {
    expect(storeTimeZone({ timezone_string: '', gmt_offset: 5.5 })).toBe('+05:30');
    expect(storeTimeZone({ timezone_string: '', gmt_offset: '-3.5' })).toBe('-03:30');
    expect(storeTimeZone({})).toBe('+00:00');
  });
});

describe('resolveRange in Asia/Kolkata', () => {
  const tz = 'Asia/Kolkata';
  const now = new Date('2026-10-11T03:00:00Z'); // 08:30 IST

  it('today runs from store midnight until now', () => {
    const r = resolveRange({ date: 'today' }, tz, now);
    expect(iso(r.after)).toBe('2026-10-10T18:30:00.000Z');
    expect(iso(r.before)).toBe(now.toISOString());
  });
  it('today just after store midnight, while UTC is still on the previous day', () => {
    const late = new Date('2026-10-10T20:00:00Z'); // 01:30 IST on 11 Oct
    expect(iso(resolveRange({ date: 'today' }, tz, late).after)).toBe('2026-10-10T18:30:00.000Z');
  });
  it('yesterday is one full store day', () => {
    const r = resolveRange({ date: 'yesterday' }, tz, now);
    expect(iso(r.after)).toBe('2026-10-09T18:30:00.000Z');
    expect(iso(r.before)).toBe('2026-10-10T18:30:00.000Z');
  });
  it('last_7_days starts six store days before today', () => {
    expect(iso(resolveRange({ date: 'last_7_days' }, tz, now).after)).toBe('2026-10-04T18:30:00.000Z');
  });
  it('works with an offset zone', () => {
    expect(iso(resolveRange({ date: 'today' }, '+05:30', now).after)).toBe('2026-10-10T18:30:00.000Z');
  });
});

describe('DST', () => {
  it('yesterday across the New York spring-forward day is 23 hours', () => {
    const r = resolveRange({ date: 'yesterday' }, 'America/New_York', new Date('2026-03-09T12:00:00Z'));
    expect(iso(r.after)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(r.before)).toBe('2026-03-09T04:00:00.000Z');
  });
  it('startOfDay matches local midnight', () => {
    expect(iso(startOfDay('America/New_York', new Date('2026-11-01T15:00:00Z'), 0))).toBe('2026-11-01T04:00:00.000Z');
  });
});

describe('explicit bounds', () => {
  const now = new Date('2026-10-11T03:00:00Z');
  it('parses ISO 8601 with offsets', () => {
    const r = resolveRange({ after: '2026-10-01T00:00:00+05:30', before: '2026-10-02T00:00:00Z' }, 'Asia/Kolkata', now);
    expect(iso(r.after)).toBe('2026-09-30T18:30:00.000Z');
    expect(iso(r.before)).toBe('2026-10-02T00:00:00.000Z');
  });
  it('returns no bounds when nothing is given', () => {
    expect(resolveRange({}, 'Asia/Kolkata', now)).toEqual({});
  });
  it('rejects date combined with after or before', () => {
    expect(() => resolveRange({ date: 'today', after: '2026-10-01T00:00:00Z' }, 'UTC', now)).toThrow(RangeError);
  });
  it('rejects after later than before', () => {
    expect(() => resolveRange({ after: '2026-10-02T00:00:00Z', before: '2026-10-01T00:00:00Z' }, 'UTC', now)).toThrow(RangeError);
  });
});

describe('toWcGmt', () => {
  it('formats UTC without zone suffix or millis', () => {
    expect(toWcGmt(new Date('2026-10-10T18:30:00.000Z'))).toBe('2026-10-10T18:30:00');
  });
});
