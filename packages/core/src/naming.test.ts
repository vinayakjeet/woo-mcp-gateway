import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeTool, exposedToolName, isValidSlug, sanitizeToolName } from './naming.js';

describe('slugs', () => {
  it.each(['main', 'fx', 'gh', 'store-2', 'a'.repeat(24)])('accepts %s', (s) => {
    expect(isValidSlug(s)).toBe(true);
  });
  it.each(['a', 'Main', '1abc', 'abc-', 'a_b', 'a__b', 'a'.repeat(25), 'ab c'])(
    'rejects %s',
    (s) => {
      expect(isValidSlug(s)).toBe(false);
    },
  );
});

describe('exposed names', () => {
  it('prefixes with two underscores', () => {
    expect(exposedToolName('main', 'list_orders')).toBe('main__list_orders');
    expect(exposedToolName('fx', 'get_info')).toBe('fx__get_info');
  });
  it('replaces characters outside [A-Za-z0-9_-] with _', () => {
    expect(sanitizeToolName('repo.search/v2')).toBe('repo_search_v2');
    expect(exposedToolName('gh', 'émoji 😀')).toBe('gh___moji__');
  });
  it('truncates past 48 characters with a hash of the original name', () => {
    const tool = 'x'.repeat(60);
    const name = exposedToolName('github-enterprise', tool);
    const hash = createHash('sha256').update(tool).digest('hex').slice(0, 6);
    expect(name).toHaveLength(48);
    expect(name.endsWith(`_${hash}`)).toBe(true);
    expect(name.startsWith('github-enterprise__xxx')).toBe(true);
  });
  it('keeps two long names that share a prefix distinct', () => {
    const a = exposedToolName('gh', 'y'.repeat(50) + 'a');
    const b = exposedToolName('gh', 'y'.repeat(50) + 'b');
    expect(a).not.toBe(b);
  });
  it('throws on an invalid slug', () => {
    expect(() => exposedToolName('Bad', 't')).toThrow(/slug/);
  });
});

describe('descriptions', () => {
  it('prefixes by server kind', () => {
    expect(describeTool({ kind: 'store', name: 'Main Store' }, 'List orders')).toBe(
      '[Store: Main Store] List orders',
    );
    expect(describeTool({ kind: 'system', name: 'Currency' }, 'Convert')).toBe(
      '[Currency] Convert',
    );
    expect(describeTool({ kind: 'external', name: 'GitHub' })).toBe('[GitHub] ');
  });
});
