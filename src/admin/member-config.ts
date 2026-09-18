import type { AdminProfile, AdminState } from './types';
import { profileSchema } from '../core/config';
import { memberReadiness } from './member-readiness';
import { createHash } from 'node:crypto';
export function memberConfig(profile: AdminProfile, state: AdminState, username: string, groupName?: string) {
  const user = state.users[username], group = groupName ? state.groups[groupName] : undefined;
  if (!user || (groupName && !group)) throw new Error('成员或项目组不存在');
  const pending = memberReadiness(state, user).filter(item => item !== '待分配项目组');
  if (pending.length) throw new Error('成员尚未开通：' + pending.join('；'));
  if (group && (!group.workspace || group.provisioning || !user.groups?.includes(group.name))) throw new Error('成员未获该工作路径授权');
  if (!profile.fingerprint) throw new Error('服务器身份尚未确认，请先重新连接服务器');
  const id = (profile.mode === 'local' ? 'local_' : 'member_') + createHash('sha256').update(JSON.stringify([state.teamId, username])).digest('hex').slice(0, 40);
  return profileSchema.parse({ mode: profile.mode, localRoot: profile.localRoot, id, name: user.name.slice(0, 120), host: profile.host, port: profile.port, username, fingerprint: profile.fingerprint, manifestPath: '', projects: [], workPath: '' });
}
