import type { UserFailure } from '../shared/user-failure';

export function submissionMayHaveArrived(failure: UserFailure, attempted: boolean) {
  if (!attempted || ['not-started', 'accepted', 'partial'].includes(failure.outcome || '')) return false;
  if (/^(?:读取|检测|检查|选择)/.test(failure.operation || '') || /^(?:preflight|validate|read-catalog|auth-check|detect)(?:$|[/:.-])/.test(failure.phase || '')) return false;
  if (failure.outcome === 'unknown') return true;
  if (['OPERATION_TIMEOUT', 'CONNECTION_INTERRUPTED', 'UNCLASSIFIED_FAILURE', 'CURSOR_SUBMISSION_UNCONFIRMED', 'CODEX_RESPONSE_UNCONFIRMED'].includes(failure.code)) return true;
  return /(?:送达|提交|操作).*(?:未能确认|尚未确认|待确认)|未能(?:及时)?确认(?:操作|发送|引导|.*送达)/.test(failure.message);
}
