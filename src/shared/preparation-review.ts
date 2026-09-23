import type { Draft } from './types';

export interface EmptyPreparationResult {
  code: 'already_saved' | 'no_reusable_content' | 'no_matching_category' | 'filtered' | 'legacy_unknown';
  explanation: string;
  existingResults?: { id: string; title: string }[];
  confirmedAt?: string;
}

export function isEmptyPreparation(draft: Draft) {
  return draft.generation === 'ready' && !draft.body.trim() && !draft.artifacts?.length;
}

export function needsPreparationConfirmation(draft: Draft) {
  if (draft.generation !== 'ready' || draft.submitted || draft.mergeCompletedAt) return false;
  return !isEmptyPreparation(draft) || !draft.emptyResult?.confirmedAt;
}

export function emptyPreparationResult(draft: Draft): EmptyPreparationResult {
  return draft.emptyResult || { code: 'legacy_unknown', explanation: '这条旧整理记录没有保存未生成成果的原因。可重新全量整理并核对分类，或确认本次不保留内容。' };
}
