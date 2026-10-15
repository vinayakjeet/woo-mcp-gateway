import { describe, expect, it } from 'vitest';
import { childTraceparent, newTraceparent, parseTraceparent, traceIdOf } from './trace.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const VALID = `00-${TRACE}-${PARENT}-01`;

describe('parseTraceparent', () => {
  it('parses a valid traceparent', () => {
    expect(parseTraceparent(VALID)).toEqual({ traceId: TRACE, parentId: PARENT, flags: '01' });
    expect(traceIdOf(VALID)).toBe(TRACE);
  });

  it.each([
    ['version ff', `ff-${TRACE}-${PARENT}-01`],
    ['a future version', `01-${TRACE}-${PARENT}-01`],
    ['uppercase hex', `00-${TRACE.toUpperCase()}-${PARENT}-01`],
    ['an all-zero trace id', `00-${'0'.repeat(32)}-${PARENT}-01`],
    ['an all-zero parent id', `00-${TRACE}-${'0'.repeat(16)}-01`],
    ['a short trace id', `00-${TRACE.slice(1)}-${PARENT}-01`],
    ['a long parent id', `00-${TRACE}-${PARENT}0-01`],
    ['a one digit flags field', `00-${TRACE}-${PARENT}-1`],
    ['an extra field', `00-${TRACE}-${PARENT}-01-extra`],
    ['trailing space', `${VALID} `],
    ['a newline', `${VALID}\n`],
    ['non hex characters', `00-${'g'.repeat(32)}-${PARENT}-01`],
    ['the empty string', ''],
  ])('refuses %s', (_name, raw) => {
    expect(parseTraceparent(raw)).toBeNull();
    expect(traceIdOf(raw)).toBeNull();
  });

  it.each([undefined, null, 5, {}, ['x']])('refuses the non-string %j', (raw) => {
    expect(parseTraceparent(raw)).toBeNull();
  });
});

describe('childTraceparent', () => {
  it('keeps the trace id and flags and makes a new parent id', () => {
    const parent = parseTraceparent(`00-${TRACE}-${PARENT}-00`)!;
    const a = childTraceparent(parent);
    const b = childTraceparent(parent);
    expect(a).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    expect(parseTraceparent(a)).toMatchObject({ traceId: TRACE, flags: '00' });
    expect(parseTraceparent(a)!.parentId).not.toBe(PARENT);
    expect(a).not.toBe(b);
  });
});

describe('newTraceparent', () => {
  it('is 00-<32 hex>-<16 hex>-01 and parses', () => {
    const t = newTraceparent();
    expect(t).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(parseTraceparent(t)).not.toBeNull();
    expect(newTraceparent()).not.toBe(t);
  });
});
