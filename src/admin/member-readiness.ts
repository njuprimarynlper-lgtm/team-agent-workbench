import type { AdminState, ManagedUser } from './types';
export function memberReadiness(state: AdminState, user: ManagedUser): string[] {
  const pending: string[] = [];
  if (user.missing) pending.push('账号身份异常');
  if (user.provisioning) pending.push('账号创建未完成');
  if (!user.enabled) pending.push('账号未启用或密码未设置');
  if (!state.sftpConfigured) pending.push('服务器成员登录配置异常');
  if (!Object.values(state.groups).some(g => g.workspace && !g.provisioning && user.groups?.includes(g.name))) pending.push('待分配项目组');
  return pending;
}
