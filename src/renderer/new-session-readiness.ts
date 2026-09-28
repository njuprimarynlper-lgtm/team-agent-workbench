export function newSessionBlockedReason(input: { projectId: string; networkPending: boolean; busy: boolean }): string | undefined {
  if (input.busy) return '正在创建会话，请稍候。';
  if (!input.projectId) return '请先选择项目。';
  if (input.networkPending) return '网络方式尚未应用：请先应用当前选择，或恢复原设置。';
  return undefined;
}
