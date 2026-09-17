import type { AdminState } from './types';

// A default for a new membership, not a rule that overrides an administrator's choice.
export function firstMemberIsAdmin(state: AdminState | undefined, groupName: string): boolean {
  return !!state?.groups[groupName] && !Object.values(state.users).some(user => user.groups?.includes(groupName));
}
