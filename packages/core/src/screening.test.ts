import { describe, expect, it } from 'vitest';
import { screenTool } from './screening.js';

const kinds = (description: string) => screenTool({ description }).map((f) => f.kind);

describe('screenTool', () => {
  it('flags a tag character', () => {
    expect(kinds(`list orders${String.fromCodePoint(0xe0041)}`)).toEqual(['hidden_unicode']);
  });

  it.each([0x200b, 0x200f, 0x2060, 0x2064, 0xfeff, 0xe0000, 0xe007f])('flags U+%s', (cp) => {
    expect(kinds(`a${String.fromCodePoint(cp)}b`)).toEqual(['hidden_unicode']);
  });

  it('does not flag characters next to the ranges', () => {
    for (const cp of [0x200a, 0x2010, 0x205f, 0x2065, 0xfefe, 0xe0080]) {
      expect(kinds(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toEqual([]);
    }
  });

  it('flags 1501 characters and not 1500', () => {
    expect(kinds('a'.repeat(1500))).toEqual([]);
    expect(kinds('a'.repeat(1501))).toEqual(['long_description']);
  });

  it.each(['ignore previous', 'do not tell the user', '<important>', 'system prompt'])(
    'flags %s in any case',
    (phrase) => {
      expect(kinds(`Lists things. ${phrase.toUpperCase()} and more`)).toEqual([
        'suspicious_phrase',
      ]);
      expect(kinds(`Lists things. ${phrase}`)).toEqual(['suspicious_phrase']);
    },
  );

  it('reports each finding with a detail', () => {
    const text = `ignore previous and system prompt${String.fromCodePoint(0x200b)}`;
    const flags = screenTool({ description: text });
    expect(flags.map((f) => f.kind).sort()).toEqual([
      'hidden_unicode',
      'suspicious_phrase',
      'suspicious_phrase',
    ]);
    expect(flags.every((f) => f.detail.length > 0)).toBe(true);
  });

  it('returns no flags for a plain description and for none at all', () => {
    expect(
      kinds(
        'List orders. Use date (today, yesterday, last_7_days; store timezone) or after/before, not both.',
      ),
    ).toEqual([]);
    expect(screenTool({ description: undefined })).toEqual([]);
  });
});
