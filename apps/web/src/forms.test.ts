import { describe, expect, it } from 'vitest';
import { passwordProblem } from './forms';

describe('passwordProblem', () => {
  it.each([
    ['short', 'short', 'At least 12 characters.'],
    ['a'.repeat(1025), 'a'.repeat(1025), 'At most 1024 characters.'],
    ['correct horse battery', 'correct horse batterx', 'The passwords do not match.'],
    ['correct horse battery', 'correct horse battery', null],
  ])('%s', (pw, confirm, want) => expect(passwordProblem(pw, confirm)).toBe(want));
});
