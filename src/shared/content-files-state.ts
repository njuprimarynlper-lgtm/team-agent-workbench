import type { SharedContent } from './content';

export type FileAvailability = 'ok' | 'missing' | 'unverified';
export interface ContentFilesState { body: FileAvailability; attachments: Record<string, FileAvailability> }

export function missingContentFiles(item: Pick<SharedContent, 'path' | 'files' | 'attachments'>) {
  return [
    ...(item.files?.body === 'missing' ? [item.path.split('/').at(-1) || '正文文件'] : []),
    ...(item.attachments || []).filter(file => item.files?.attachments[file.sha256] === 'missing').map(file => file.name)
  ].sort();
}
export function contentFileNotice(item: Pick<SharedContent, 'files' | 'attachments' | 'path'>) {
  if (item.files?.body === 'missing') return '成果文件缺失，暂不能存入个人库或加入会话。';
  if (item.files?.body === 'unverified') return '暂无法确认成果文件可访问，请稍后刷新。';
  const missing = missingContentFiles(item);
  if (missing.length) return `关联附件缺失：${missing.join('、')}。成果文字仍可查看和使用。`;
  if (Object.values(item.files?.attachments || {}).includes('unverified')) return '部分附件暂无法确认可访问，成果文字仍可查看和使用。';
  return '';
}
export function assertContentReadable(item: SharedContent, includeAttachments = false) {
  if (item.deletedAt) throw new Error('团队成果已删除，请刷新');
  if (item.files && item.files.body !== 'ok') throw new Error(contentFileNotice(item));
  if (includeAttachments && Object.values(item.files?.attachments || {}).some(status => status !== 'ok')) throw new Error('关联附件缺失或暂不可访问，请刷新并检查附件后再合并');
}
