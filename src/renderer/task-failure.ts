import { userFailure } from '../shared/user-failure';
import { getRememberedFailure, rememberFailure } from './error-notice';

/** Add the concrete UI action without duplicating an IPC operation prefix. */
export function taskFailure(error: unknown, operation: string, acceptedMessage?: string) {
  const remembered = typeof error === 'string' ? getRememberedFailure(error) : undefined;
  const failure = userFailure(remembered ? { failure: remembered } : error, { domain: 'central', operation });
  const prefixes = [operation, Reflect.get(failure, 'operation'), '执行此操作', '操作项目任务', '处理项目任务', '读取项目任务', '派发任务', '刷新任务列表', '读取关联成果列表', '读取任务负责人列表'].filter((value): value is string => typeof value === 'string' && !!value);
  let detail = failure.message.trim();
  for (;;) {
    const prefix = prefixes.find(value => detail.startsWith(value + '：') || detail.startsWith(value + ':'));
    if (!prefix) break;
    detail = detail.slice(prefix.length + 1).trimStart();
  }
  const retry: Record<string, string> = {
    '派发任务': '没收到派发结果，填写内容还在。再次点“确认派发”会沿用这次任务，不会多建一条。',
    '读取关联成果列表': '关联成果没加载出来。点“刷新成员和成果”再试，填写内容会保留。',
    '读取任务负责人列表': '成员列表没加载出来。请点“刷新成员和成果”再试。',
    '刷新任务列表': '任务列表没加载出来。请点“刷新任务”再试。',
  };
  const generic = ['UNCLASSIFIED_FAILURE', 'OPERATION_TIMEOUT', 'CONNECTION_INTERRUPTED', 'CONNECTION_UNAVAILABLE'].includes(failure.code) || failure.code === 'BUSINESS_RULE' && /有没有完成，还没收到确认|没有返回结果。请重新读取/.test(failure.message);
  const message = /任务编号已使用/.test(failure.message) ? '这次任务已存在，但内容与当前表单不同。请先关闭窗口，到“我派发的”查看原任务。' : acceptedMessage || (generic && retry[operation] ? retry[operation] : detail.startsWith(operation) ? detail : operation + '：' + detail);
  rememberFailure({ ...failure, message, ...(acceptedMessage ? { outcome: 'accepted' as const } : {}) });
  return message;
}
