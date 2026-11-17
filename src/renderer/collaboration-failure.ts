import { userFailure, type FailureContext } from '../shared/user-failure';
import { getRememberedFailure, rememberFailure } from './error-notice';

/** The screen supplies the next action; the original failure still locates its log. */
export function collaborationFailure(error: unknown, message: string, context: FailureContext = {}) {
  const remembered = typeof error === 'string' ? getRememberedFailure(error) : undefined;
  const failure = userFailure(remembered ? { failure: remembered } : error, context);
  const business = ['BUSINESS_RULE', 'PROJECT_ACCESS_REVOKED', 'PROJECT_DELETED', 'PASSWORD_CHANGE_REQUIRED', 'EXISTING_ACCOUNT_COLLISION', 'CENTRAL_IDENTITY_CHANGED'].includes(failure.code)
    && !/执行此操作|原因尚未确认|尚未确认操作结果|原请求回执|有没有完成，还没收到确认|没有返回结果。请重新读取/.test(failure.message);
  const text = !['accepted', 'partial'].includes(context.outcome || '') && business ? failure.message : message;
  rememberFailure({ ...failure, message: text, ...(context.operation ? { operation: context.operation } : {}), ...(context.outcome ? { outcome: context.outcome } : {}) });
  return text;
}
