import { describe, expect, it } from 'vitest';
import { auditQuery, EMPTY_FILTERS, outcomeTone } from './audit';

describe('auditQuery', () => {
  it('leaves out empty filters', () => {
    expect(auditQuery(EMPTY_FILTERS)).toBe('');
  });
  it('sends filters, the cursor, and local datetime inputs as UTC', () => {
    const q = new URLSearchParams(
      auditQuery(
        { ...EMPTY_FILTERS, server: 'fx', outcome: 'ok', from: '2026-10-12T10:00', user: 'u1' },
        'c1',
      ),
    );
    expect(q.get('server')).toBe('fx');
    expect(q.get('outcome')).toBe('ok');
    expect(q.get('user')).toBe('u1');
    expect(q.get('cursor')).toBe('c1');
    expect(q.get('from')).toBe(new Date('2026-10-12T10:00').toISOString());
    expect(q.get('from')).toMatch(/Z$/);
    expect(q.has('to')).toBe(false);
  });
});

describe('outcomeTone', () => {
  it.each([
    ['ok', 'ok'],
    ['denied', 'warn'],
    ['rate_limited', 'warn'],
    ['disabled', 'warn'],
    ['timeout', 'bad'],
    ['upstream_error', 'bad'],
  ])('%s is %s', (o, tone) => expect(outcomeTone(o)).toBe(tone));
});
