import { userFailure, type UserFailure } from './user-failure';
import type { Draft } from './types';

/** All preparation surfaces must agree about an interrupted result. */
export function preparationResultUnconfirmed(draft: Pick<Draft, 'generation' | 'generationError' | 'generationErrorFailure'>, provider?: string) {
  if (draft.generation !== 'error') return false;
  const failure = preparationFailure(draft.generationErrorFailure ? { failure: draft.generationErrorFailure, message: draft.generationError } : draft.generationError, provider);
  if (failure.outcome) return failure.outcome === 'unknown';
  return failure.code === 'OPERATION_TIMEOUT' || /(?:结果|操作结果)(?:尚未确认|待确认|待核对)|未能及时确认|还没收到确认/.test(draft.generationError || '');
}
export function preparationFailure(error: unknown, provider?: string): UserFailure {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : (error as any)?.message || '';
  const name = provider === 'codex' ? 'Codex' : provider === 'cursor' ? 'Cursor' : provider === 'claude' ? 'Claude Code' : '整理程序';
  const existing = (error as any)?.failure as UserFailure | undefined;
  if (existing?.version === 1 && /^PREPARATION_/.test(existing.code)) return existing;
  const tooMany = /(?:本次)?整理超过\s*(\d+)\s*项/.exec(raw);
  if (tooMany) return { version: 1, code: 'PREPARATION_TOO_MANY_RESULTS', outcome: 'partial', phase: 'validate-output', message: `AI 生成的成果超过 ${tooMany[1]} 项，这次结果没有保存。点“重试”，让 AI 精简后重新整理。` };
  const unselected = /(?:AI 返回了)?未选择的[“「]([^”」]+)[”」]/.exec(raw);
  if (unselected) return { version: 1, code: 'PREPARATION_UNSELECTED_CATEGORY', outcome: 'partial', phase: 'validate-output', message: `AI 使用了你未选的“${unselected[1]}”分类，这次结果没有保存。点“重试”，按你选择的分类重新整理。` };
  if (/^initialize\s+(?:timeout|超时)$/i.test(raw) || /^整理尚未开始：连接本机 CLI 超时/.test(raw)) return { version: 1, code: 'PREPARATION_START_TIMEOUT', outcome: 'not-started', message: `${name} 一直没有启动，成果还没开始整理。点“重试”再试；仍没反应时，到左下角“agent管理”检测程序。` };
  if (/CLI.*登录.*(?:检测|状态).*(?:超时|失败|无法)/.test(raw)) return { version: 1, code: 'PREPARATION_AUTH_UNAVAILABLE', outcome: 'not-started', message: `这次没测出 ${name} 能否登录，成果没有整理完成。到左下角“agent管理”重新检测账号后，再点“重试”。` };
  if (/\bECONNRESET\b|\bconnection reset\b|\bsocket hang up\b/i.test(raw) || /^网络连接中断，整理结果尚未确认/.test(raw)) return { version: 1, code: 'PREPARATION_CONNECTION_INTERRUPTED', outcome: 'unknown', message: '网络断开了，工作台没拿到完整的整理结果。先查看下面“已收到的整理内容”，有需要的先复制保留；没有可用内容，再重新整理。' };
  if (/^CLI 进程已退出(?:[（(](?:-?\d+|null)[）)])?$/.test(raw) || /^CLI 意外停止，整理尚未完成/.test(raw)) return { version: 1, code: 'PREPARATION_PROCESS_EXITED', message: `${name} 意外停止，成果没有整理完成。点“重试”重新整理；如果再次停止，到左下角“agent管理”检测程序。` };
  return userFailure(error, { domain: 'cli', operation: '整理成果', provider });
}
export function preparationErrorMessage(error: unknown, provider?: string) { return preparationFailure(error, provider).message; }

/** A global notice needs a route to the task, rather than the card's "below". */
export function preparationNoticeFailure(title: string, failure: UserFailure): UserFailure {
  const unknown = failure.outcome === 'unknown';
  const reason = failure.message.split('。')[0].replace(/，成果没有整理完成$/, '');
  return { ...failure, operation: failure.operation || '整理成果', message: `“${title}”的成果整理${unknown ? '中断' : '未完成'}。${reason}。请点左侧“更多”打开“成果整理”，${unknown ? '查看这次收到的内容，先别重新整理' : '打开这次任务查看原因后再重试'}。` };
}
