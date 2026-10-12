import type { Member, Tone } from './types';

// Mirrors the API: no changes to yourself, and keys only for members who can sign in.
export function memberActions(u: Pick<Member, 'id' | 'status'>, meId: string) {
  const self = u.id === meId;
  return {
    canChangeRole: !self,
    canDisable: !self && u.status !== 'disabled',
    canEnable: !self && u.status === 'disabled',
    canIssueKey: u.status === 'active',
  };
}

export const MEMBER_TONE: Record<Member['status'], Tone> = {
  active: 'ok',
  invited: 'warn',
  disabled: 'off',
};
