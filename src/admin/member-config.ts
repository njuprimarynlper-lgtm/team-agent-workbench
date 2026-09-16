import type { AdminProfile, AdminState, ManagedUser } from './types';
import { profileSchema } from '../core/config';
import { memberReadiness } from './member-readiness';
export function memberConfig(profile: AdminProfile, state: AdminState, username: string, groupName: string) {
  const user = state.users[username], group = state.groups[groupName];
  if (!user || !group) throw new Error('成员或项目组不存在');
  const pending = memberReadiness(state, user);
  if (pending.length) throw new Error('成员尚未开通：' + pending.join('；'));
  if (!group.workspace || group.provisioning || !user.groups?.includes(groupName)) throw new Error('成员未获该工作路径授权');
  if (!profile.fingerprint) throw new Error('缺少经过验证的服务器指纹');
  return profileSchema.parse({ id: `${state.teamId}-${username}-${group.label}`, name: `${group.label} · ${user.name}`.slice(0, 120), host: profile.host, port: profile.port, username, fingerprint: profile.fingerprint, manifestPath: '', projects: [], workPath: group.workspace });
}
