import type { Draft, Transfer } from './types';
export function contributionStatus(draft: Draft, transfer?: Transfer) {
  if (draft.mergeCompletedAt) return '合并完成';
  if (draft.submitted) return transfer ? ({ queued: '等待上传', running: '上传中', done: '上传成功', error: '上传失败' })[transfer.status] : '上传状态待核对';
  return draft.generation === 'running' ? draft.mergeSources?.length ? '语义融合中' : '整理中' : draft.generation === 'error' ? draft.mergeSources?.length ? '融合失败' : '整理失败' : draft.generation === 'canceled' ? '已停止' : draft.mergeSources?.length ? '待确认合并' : '待确认';
}
