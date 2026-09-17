import type { Draft, Transfer } from './types';
export function contributionStatus(draft: Draft, transfer?: Transfer) {
  if (draft.submitted) return transfer ? ({ queued: '等待上传', running: '上传中', done: '上传成功', error: '上传失败' })[transfer.status] : '上传状态待核对';
  return draft.generation === 'running' ? '整理中' : draft.generation === 'error' ? '整理失败' : draft.generation === 'canceled' ? '已停止' : '待确认';
}
