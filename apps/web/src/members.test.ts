import { describe, expect, it } from 'vitest';
import { memberActions } from './members';

const me = 'me-id';

describe('memberActions', () => {
  it('lets an admin act on others but never on themselves', () => {
    expect(memberActions({ id: me, status: 'active' }, me)).toEqual({
      canChangeRole: false,
      canDisable: false,
      canEnable: false,
      canIssueKey: true,
    });
  });
  it.each([
    ['active', { canChangeRole: true, canDisable: true, canEnable: false, canIssueKey: true }],
    ['invited', { canChangeRole: true, canDisable: true, canEnable: false, canIssueKey: false }],
    ['disabled', { canChangeRole: true, canDisable: false, canEnable: true, canIssueKey: false }],
  ] as const)('%s member', (status, want) =>
    expect(memberActions({ id: 'x', status }, me)).toEqual(want),
  );
});
