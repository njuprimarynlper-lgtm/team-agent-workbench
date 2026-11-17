import type { Transfer } from './types';
import { uiErrorMessage, userFailure } from './user-failure';

/** The byte stream ending is not proof that the server published the result. */
export function transferFailureMessage(task: Pick<Transfer, 'phase' | 'kind'> & { cacheCleared?: boolean }, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error || '');
  if (task.phase === 'completed') {
    if (/^文件已(?:上传|下载)[。，]/.test(detail)) return detail;
    const code = userFailure(error, { domain: 'local' }).code;
    const record = task.kind === 'download' ? '下载记录' : '上传记录';
    const recovery = code === 'STORAGE_FULL' ? `这台电脑空间不够，${record}没存好。请腾出空间后点“重试保存记录”。` : code === 'FILE_ACCESS_DENIED' ? `${record}没存好。请按日志检查保存位置的权限，再点“重试保存记录”。` : `${record}没存好。请点“重试保存记录”；仍失败时查看日志。`;
    return (task.kind === 'download' ? '文件已下载，无需重新下载。' : '文件已上传，无需重新上传。') + recovery;
  }
  if (task.cacheCleared) return '这次上传的临时文件已清理，不能重试。点“查看详情”把上传位置交给项目管理者，先确认是否收到，别再上传一份。';
  if (detail.includes('不支持的成果类别')) return '服务器还不支持这个成果类别。请管理员用当前版本的管理端打开用户管理，点击“更新服务端功能”后再重试。';
  const prefix = task.phase === 'awaiting_receipt' ? '文件可能已上传，暂时没查到结果。恢复连接后点“检查上传结果”，会先检查这次上传，避免重复上传。'
    : task.phase === 'streaming' ? '传输中断了。恢复连接后点“重试”，会重新传输这份文件。'
      : task.phase === 'verifying' ? '文件传完了，但完整性检查还没通过。请点“重试”。'
        : task.phase === 'rejected' ? '服务器没有接受这次上传。请检查账号和项目权限，再点“重试”。'
          : '文件还没开始传输。请点“重试”。';
  if (detail.startsWith(prefix)) return detail;
  // File-system failures can come from either endpoint. Never infer a server
  // fault from an upload cache error, or a local fault from a server disk error.
  if (/\b(?:ENOENT|EACCES|EPERM|ENOSPC)\b/.test(detail)) return prefix + ' 文件、空间或访问权限有问题，详情可查看日志。';
  return prefix;
}

export function transferRecordError(task: Transfer) {
  if (!task.error) return '';
  // This message already combines the confirmed receipt with a local persistence
  // failure. Reclassifying its readable storage reason would erase that fact.
  if (task.phase === 'completed') return /^(?:文件已上传|文件已下载)/.test(task.error) ? task.error : transferFailureMessage(task, task.error);
  if (task.cacheCleared || task.phase) return transferFailureMessage(task, task.error);
  return /\bE[A-Z]{3,}\b|Error:|Traceback|\[MEMBER_/.test(task.error)
    ? transferFailureMessage(task, task.error)
    : uiErrorMessage(task.error, { domain: 'transfer', operation: '传输文件', outcome: 'unknown', phase: task.phase });
}
