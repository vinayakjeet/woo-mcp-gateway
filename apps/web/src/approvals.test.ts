import { describe, expect, it } from 'vitest';
import { definitionText, diffLines, showHidden } from './approvals';

describe('showHidden', () => {
  it('turns characters nobody can see into visible markers', () => {
    expect(showHidden('ab​cd')).toBe('ab<U+200B>cd');
    expect(showHidden('x\u{E0041}y')).toBe('x<U+E0041>y');
    expect(showHidden('﻿start')).toBe('<U+FEFF>start');
  });

  it('leaves normal text, newlines and non-latin letters alone', () => {
    expect(showHidden('plain\ntext é 日本')).toBe('plain\ntext é 日本');
  });
});

describe('diffLines', () => {
  it('marks added and removed lines and keeps the rest', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('shows everything as added when there is no old text', () => {
    expect(diffLines('', 'a\nb')).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
    ]);
  });

  it('returns only same lines for equal text', () => {
    expect(diffLines('a\nb', 'a\nb').every((l) => l.kind === 'same')).toBe(true);
  });
});

describe('definitionText', () => {
  it('lists description, input schema and annotations as lines', () => {
    const text = definitionText({
      description: 'Does it.\nTwice.',
      inputSchema: { type: 'object' },
      annotations: null,
    });
    expect(text.split('\n')).toEqual([
      'description:',
      'Does it.',
      'Twice.',
      'inputSchema:',
      '{',
      '  "type": "object"',
      '}',
      'annotations:',
      'null',
    ]);
  });

  it('writes a missing description as an empty one', () => {
    expect(definitionText({ description: null, inputSchema: {}, annotations: null })).toContain(
      'description:\n\ninputSchema:',
    );
  });
});
