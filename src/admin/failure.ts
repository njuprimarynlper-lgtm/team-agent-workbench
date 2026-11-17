import { uiErrorMessage, userFailure } from '../shared/user-failure';
import { getRememberedFailure, rememberFailure } from '../renderer/error-notice';
import type { AdminJob } from './types';

/** Protocol tags identify recovery paths; they are not instructions for administrators. */
export function adminErrorMessage(error: unknown, operation = '管理操作') {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : typeof (error as any)?.message === 'string' ? (error as any).message : '';
  const business = raw.replace(/^\[MEMBER_[A-Z_]+\]\s*/, '');
  const remembered = typeof error === 'string' ? getRememberedFailure(error) : undefined;
  const failure = userFailure(remembered ? { failure: remembered } : error, { domain: 'admin', operation });
  const finish = (message: string) => { rememberFailure({ ...failure, message, operation }); return message; };
  if (operation === '连接中央节点' && failure.code === 'CENTRAL_AUTH_REJECTED') return finish('没能登录中央节点，账号或密码没通过验证。请点左下角“连接设置”检查后重新连接。');
  if (operation === '连接中央节点' && /未及时返回账号检查结果/.test(raw)) return finish('中央节点迟迟没有返回账号检查结果。请点左下角“连接设置”重新连接，再刷新用户列表。');
  if (failure.code === 'PROJECT_CATALOG_INCOMPLETE') return finish('没能读全可清理的项目，清理还没开始。请点“重新读取项目”再试。');
  if (failure.code === 'PROJECT_RESULT_INDEX_UNREADABLE') return finish(`没能读取${/^清理项目「(.+)」$/.exec(operation)?.[1] ? '项目「' + /^清理项目「(.+)」$/.exec(operation)![1] + '」' : '这个项目'}的成果文件清单，本次没有删除文件。请点“重新读取项目”再试；仍失败时查看日志。`);
  const generic = failure.code === 'UNCLASSIFIED_FAILURE' || /原因尚未确认|仍失败时请查看日志|^(?:执行此操作|执行服务器管理操作|管理操作)[：:]/.test(raw);
  if (generic) {
    const messages: Record<string, string> = {
      '修复远端服务器环境': '没拿到这次修复的结果。请再点“在服务器执行修复”；仍失败时查看日志。',
      '检测已有账号及权限': '没读到这个账号的资料。请再点“检测已有账号及权限”试一次。',
      '验证密码并接入已有账号': '没拿到账号接入的结果，先不要重复接入。请查看日志。',
      '同步成员': '成员列表这次没更新，稍后会自动再试。',
      '配置共享服务器中转': '没读到中转连接结果。请点“启用服务器中转”再试；仍失败时查看日志。',
      '读取项目列表': '项目列表没加载出来。请点“刷新项目”再试。',
      '读取可清理项目': '项目列表没读全，清理还没开始。请点“重新读取项目”再试。',
    };
    const service = /^测试 (Codex|Cursor|Claude Code) 网络$/.exec(operation)?.[1];
    const account = /^检测账号「(.+)」的资料$/.exec(operation)?.[1];
    return finish(account ? `账号「${account}」的资料没加载出来。请再点“检测已有账号及权限”。` : service ? `没能检查这台管理电脑是否能连接 ${service}。请再点“测试 ${service}”；仍失败时查看日志。` : messages[operation] || `${operation}没完成，请再试一次。`);
  }
  if (/^测试.*网络$/.test(operation) && (/HTTP\s*(?:401|403|429)\b/i.test(raw) || /^MODEL_(?:AUTH|ACCESS|REQUEST)/.test((error as any)?.failure?.code || '')))
    return finish('这次连接测试被拒绝了。请检查已保存的出口设置，再重新测试。');
  if (/\b(?:ENOENT|EACCES|EPERM|ENOSPC)\b/.test(raw)) return finish(`${operation}未能完成：所需文件、存储空间或访问权限不可用，请在日志中核对具体位置后重试。`);
  return finish(uiErrorMessage(business !== raw ? business : error, { domain: 'admin', operation }));
}

export function adminOperationLabel(job: AdminJob) {
  const labels: Record<string, string> = { initialize: '初始化团队空间', user_create: '创建用户', user_import: '接入已有账号', user_password: '重置密码', user_enabled: '更新账号启用状态', user_groups: '更新项目成员与角色', member_groups: '更新项目成员与角色', group_member: '更新项目成员与角色', group_create: '创建项目', workspace_prepare: '准备项目工作目录', storage_upgrade: '更新服务端功能' };
  const target = job.request.name || job.request.username || job.request.label || job.request.group;
  return (labels[job.op] || '管理操作') + (target ? `「${target}」` : '');
}

/** These checkpoints are written only after the corresponding server step succeeds. */
export function adminRecoverySummary(job: AdminJob) {
  const account = job.request.username || job.request.name || '此成员';
  if (job.op === 'user_create' && job.completed.includes('专用账号已创建')) return job.completed.includes('初始密码已设置')
    ? `账号「${account}」和初始密码已设置好，项目权限还没配完。点“继续配置”完成开通。`
    : `账号「${account}」已创建，初始登录密码还没设置。点“继续配置”设置密码，完成开通。`;
  return `${adminOperationLabel(job)}还没做完。已完成的步骤会保留，点“继续配置”接着处理。`;
}
