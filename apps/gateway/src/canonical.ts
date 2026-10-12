import { createHash } from 'node:crypto';

// Sorted keys, so two encodings of the same arguments or definition hash the same.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// Iterative, so a hostile argument tree cannot overflow the stack here or in canonicalJson.
export function nestsDeeperThan(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  for (let top = stack.pop(); top; top = stack.pop()) {
    const [v, depth] = top;
    if (v === null || typeof v !== 'object') continue;
    if (depth >= max) return true;
    for (const child of Object.values(v)) stack.push([child, depth + 1]);
  }
  return false;
}
