import { userFailure, type FailureContext } from '../shared/user-failure';
import { rememberFailure } from './error-notice';

/** A screen supplies complete sentences for its own objects and controls. */
export function contextualError(error: unknown, context: FailureContext, wording: Readonly<Record<string, string>>) {
  const failure = userFailure(error, context);
  const message = wording[failure.code] || failure.message;
  if (message !== failure.message) rememberFailure({ ...failure, message });
  return message;
}
export const toolName = (provider: string) => provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude Code' : 'Cursor';
export function modelReadError(error: unknown, provider: string, refresh = '刷新模型与额度') {
  return contextualError(error, { domain: 'model', operation: `读取${toolName(provider)}模型`, provider }, {
    CLI_PATH_INVALID: `找不到本机 ${toolName(provider)} 程序。关闭此面板后，到左下角“agent管理”重新检测或选择程序。`,
    OPERATION_TIMEOUT: `${toolName(provider)} 的模型列表一直没有返回。点“${refresh}”再试。`,
    UNCLASSIFIED_FAILURE: `这次没读到 ${toolName(provider)} 的模型列表。点“${refresh}”重新读取。`,
  });
}
