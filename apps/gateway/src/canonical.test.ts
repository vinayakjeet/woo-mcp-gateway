import { describe, expect, it } from 'vitest';
import { canonicalJson, nestsDeeperThan, sha256Hex } from './canonical.js';

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"e":2,"f":1}]},"b":1}',
    );
  });

  it('drops undefined members and keeps array order', () => {
    expect(canonicalJson({ a: undefined, b: [2, 1] })).toBe('{"b":[2,1]}');
  });

  it('escapes keys and strings like JSON', () => {
    expect(canonicalJson({ 'q"': 'line\n' })).toBe('{"q\\"":"line\\n"}');
  });
});

describe('sha256Hex', () => {
  it('hashes reordered keys the same and different values differently', () => {
    const a = sha256Hex(canonicalJson({ x: 1, y: 2 }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(canonicalJson({ y: 2, x: 1 }))).toBe(a);
    expect(sha256Hex(canonicalJson({ x: 1, y: 3 }))).not.toBe(a);
  });
});

describe('nestsDeeperThan', () => {
  const nest = (n: number) => {
    let v: unknown = 1;
    for (let i = 0; i < n; i++) v = [v];
    return v;
  };
  it('counts containers, not scalars', () => {
    expect(nestsDeeperThan(nest(3), 3)).toBe(false);
    expect(nestsDeeperThan(nest(4), 3)).toBe(true);
    expect(nestsDeeperThan({ a: { b: 1 } }, 2)).toBe(false);
    expect(nestsDeeperThan(undefined, 1)).toBe(false);
  });
  it('does not recurse, so a very deep tree is safe', () => {
    expect(nestsDeeperThan(nest(200_000), 64)).toBe(true);
  });
});
