import type { Provider, ProviderAuth } from '../shared/types';

export function newSessionBlockedReason(input: {
  projectId: string; networkPending: boolean; networkBusy: boolean; busy: boolean;
  managementRoute: boolean; provider: Provider; cwd: string;
  checked?: { provider: Provider; cwd: string; auth: ProviderAuth };
  latestAuth?: ProviderAuth;
}): string | undefined {
  if (input.busy) return '正在创建会话，请稍候。';
  if (!input.projectId) return '请先选择项目。';
  if (input.networkPending) return '网络方式尚未应用：请先应用当前选择，或恢复原设置。';
  if (input.managementRoute) {
    if (!input.cwd) return '本地工作目录尚未就绪，无法检测所选 AI 账号。';
    const latest = input.latestAuth?.cwd === input.cwd && input.latestAuth.networkRoute === 'management' ? input.latestAuth : undefined;
    if (input.networkBusy || latest && ['checking', 'logging-in'].includes(latest.status)) return '正在检测所选 AI 账号；检测成功后可创建会话。';
    if (!input.checked || input.checked.provider !== input.provider || input.checked.cwd !== input.cwd) return '所选 AI 账号尚未检测成功，请等待或重新检测。';
    const checkedAt = input.checked.auth.checkedAt || '';
    const account = latest?.checkedAt && latest.checkedAt > checkedAt ? latest : input.checked.auth;
    if (!['authenticated', 'configured', 'not-required'].includes(account.status)) return '所选 AI 账号尚未检测成功，请登录或重新检测。';
  }
  return undefined;
}
