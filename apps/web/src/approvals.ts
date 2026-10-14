export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

// Same characters as the hidden_unicode screen in @woo/core. The admin cannot see them in the
// text, so the page prints each one as a marker before showing a description.
const HIDDEN = /[\u{E0000}-\u{E007F}\u{200B}-\u{200F}\u{2060}-\u{2064}\u{FEFF}]/gu;

export function showHidden(text: string): string {
  return text.replace(
    HIDDEN,
    (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`,
  );
}

export function definitionText(d: {
  description: string | null;
  inputSchema: unknown;
  annotations: unknown;
}): string {
  return [
    'description:',
    d.description ?? '',
    'inputSchema:',
    JSON.stringify(d.inputSchema ?? null, null, 2),
    'annotations:',
    JSON.stringify(d.annotations ?? null, null, 2),
  ].join('\n');
}

const lines = (s: string) => (s === '' ? [] : s.split('\n'));

// Longest common subsequence over lines. Definitions are a few dozen lines, so the quadratic
// table is fine.
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = lines(oldText);
  const b = lines(newText);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i++]! });
    } else {
      out.push({ kind: 'add', text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'add', text: b[j++]! });
  return out;
}
