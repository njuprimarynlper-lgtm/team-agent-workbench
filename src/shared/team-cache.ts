import type { ConnectionProfile, WorkspaceAccess } from './types';
import { z } from 'zod';

export const teamCacheRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('content.list'), projectId: z.string().min(1) }),
  z.object({ action: z.literal('content.history'), projectId: z.string().min(1) }),
  z.object({ action: z.literal('assignment.list'), projectId: z.string().min(1) }),
  z.object({ action: z.literal('assignment.members'), projectId: z.string().min(1) }),
  z.object({ action: z.literal('question.members'), projectId: z.string().min(1) }),
  z.object({ action: z.literal('directions.list') }),
  z.object({ action: z.literal('group.details'), group: z.string().min(1) }),
  z.object({ action: z.literal('group.directory'), group: z.string().min(1) }),
]);
export type TeamCacheRequest = z.infer<typeof teamCacheRequestSchema>;
export interface TeamCacheEntry<T> { value: T; savedAt: string }
// A failed connection is not evidence that the user lost access.
export function teamAccessRevoked(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return ['TEAM_ACCESS_REVOKED', 'PROJECT_ACCESS_REVOKED', 'PROJECT_DELETED'].includes(String(code)) || /没有此项目的访问权限|模拟权限拒绝：不属于此项目|当前账号未启用或不属于此团队|账号已停用或身份已改变|模拟权限拒绝：账号已停用|(?:^|：)(?:项目已删除|项目不存在|项目入口不存在|项目不存在或尚未准备好)$/.test(message);
}

export function teamAccessKey(profile: ConnectionProfile | undefined, workspaces: WorkspaceAccess[]) {
  return JSON.stringify([profile?.projects.map(project => [project.id, project.groupName]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))) || [], workspaces.map(group => [group.groupName, group.role]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
}

export function teamTransportFailure(error: unknown) {
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EPIPE|EIO|EBUSY|网络|连接|通信|timed? ?out|timeout|socket|channel|connection|temporar/i.test(error instanceof Error ? error.message : String(error));
}
export function teamManifestUntrusted(error: unknown) {
  return /不可信的项目记录|项目记录过大|项目记录格式无效|新版管理员端刷新成员信息|共享目录路径无法识别|本地权限桩配置无效/.test(error instanceof Error ? error.message : String(error));
}
