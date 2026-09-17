import type { ConnectionProfile, OfflineAuthorization, RemoteBinding, WorkspaceAccess } from '../shared/types';
import { sameEndpoint } from './sftp';
export function workspaceMode(connected: boolean, groups: WorkspaceAccess[], lease?: OfflineAuthorization, now = Date.now()) {
  if (connected) return groups.length ? 'online' as const : 'unassigned' as const;
  if (!lease?.workspaces.length) return 'unassigned' as const;
  const verified = Date.parse(lease.verifiedAt), expires = Date.parse(lease.expiresAt);
  return Number.isFinite(verified) && now >= verified - 60000 && expires > now ? 'offline' as const : 'readonly' as const;
}
export function authorizeOffline(binding: RemoteBinding | undefined, lease?: OfflineAuthorization, now = Date.now()) {
  if (!binding || !lease || workspaceMode(false, [], lease, now) !== 'offline' || !sameEndpoint(binding, lease.profile) || !lease.workspaces.some(w => !w.accessError && w.groupName === binding.project.groupName) || !lease.profile.projects.some(p => p.id === binding.project.id && p.remoteRoot === binding.project.remoteRoot)) throw new Error('离线授权已过期或不覆盖此项目，请重新连接团队账号核验；已有记录仍可查看');
}
export function makeAuthorization(profile: ConnectionProfile, workspaces: WorkspaceAccess[], hours = 8): OfflineAuthorization {
  const now = Date.now(); return { profile: structuredClone(profile), workspaces: structuredClone(workspaces), verifiedAt: new Date(now).toISOString(), expiresAt: new Date(now + Math.min(24, Math.max(1, hours)) * 3600000).toISOString() };
}
