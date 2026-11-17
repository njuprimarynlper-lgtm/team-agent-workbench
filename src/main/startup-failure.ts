import { dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { userFailure } from '../shared/user-failure';
import { logsFor, accountLogScope } from '../core/logging';
export function startupFailureOptions(title: string, error: unknown) {
  const failure = userFailure(error, { domain: 'local', operation: '打开工作台' });
  const record = /管理/.test(title) ? '管理配置' : '会话记录';
  const message = failure.code === 'LOCAL_DATA_UNREADABLE' ? `读不到这台电脑上的${record}，工作台无法启动。`
    : failure.code === 'STORAGE_FULL' ? '这台电脑的磁盘空间不足，工作台无法启动。请先清理空间。'
      : '工作台没能打开。请把启动日志交给维护人员排查。';
  return { type: 'error' as const, title, message,
    detail: '请不要删除工作台数据。点“打开日志文件夹”，将最新日志交给维护人员。',
    buttons: ['关闭', '打开日志文件夹'], defaultId: 0, cancelId: 0, noLink: true };
}
async function openLogs(dataRoot: string) {
  try {
    const directory = path.join(dataRoot, 'logs');
    const info = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (!info) await fs.mkdir(directory, { recursive: true });
    const result = await shell.openPath(info && (!info.isDirectory() || info.isSymbolicLink()) ? dataRoot : directory);
    if (result) throw Error(result);
    return;
  } catch (error: any) {
    try { logsFor(dataRoot).record('diagnostic', 'logs.open_failed', accountLogScope(dataRoot), { level: 'error', detail: error?.message || String(error) }); } catch { /* Best effort when the log directory itself is unavailable. */ }
    await dialog.showMessageBox({ type: 'error', title: '日志文件夹没有打开', message: '日志文件夹暂时打不开。请联系维护人员检查这台电脑的工作台数据。', buttons: ['关闭'] });
  }
}
export async function showStartupFailure(title: string, error: unknown, dataRoot: string) {
  const result = await dialog.showMessageBox(startupFailureOptions(title, error));
  if (result.response === 1) await openLogs(dataRoot);
}
export async function showRecordSaveFailure(dataRoot: string) {
  const result = await dialog.showMessageBox({ type: 'error', title: '最近的会话记录可能没保存', message: '窗口已关闭，但最近的会话记录可能没有保存。', detail: '请不要删除工作台数据。点“打开日志文件夹”，将最新日志交给维护人员排查。', buttons: ['关闭', '打开日志文件夹'], defaultId: 0, cancelId: 0, noLink: true });
  if (result.response === 1) await openLogs(dataRoot);
}
