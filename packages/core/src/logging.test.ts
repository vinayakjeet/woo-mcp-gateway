import { describe, expect, it } from 'vitest';
import { LOG_REDACT, errorCode } from './logging.js';

describe('errorCode', () => {
  it('finds a code on the error or down its cause chain', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
    const wrapped = new Error('Failed query: insert ... params: s3cr3t', {
      cause: Object.assign(new Error('dup'), { code: '23505' }),
    });
    expect(errorCode(wrapped)).toBe('23505');
  });
  it('never returns message text', () => {
    expect(errorCode(new Error('password=hunter2'))).toBe('unknown');
    expect(errorCode(Object.assign(new Error('x'), { code: 'has spaces and=secret' }))).toBe(
      'unknown',
    );
    expect(errorCode('a string')).toBe('unknown');
    expect(errorCode(null)).toBe('unknown');
  });
  it('survives a cause cycle', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    a.cause = a;
    expect(errorCode(a)).toBe('unknown');
  });
});

describe('LOG_REDACT', () => {
  it('covers cookies, authorization and set-cookie', () => {
    expect(LOG_REDACT).toEqual(
      expect.arrayContaining([
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
      ]),
    );
  });
});
