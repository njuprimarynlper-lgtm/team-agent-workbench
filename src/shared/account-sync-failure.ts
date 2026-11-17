export const accountSyncCacheUnavailableMessage = '这台电脑的同步记录读不了，自动同步没能启动。资料仍保存在本机，请把日志交给维护人员处理。';

export function accountSyncFailureMessage(error: unknown) {
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/账号同步缓存无法读取|这台电脑的同步记录读不了/.test(detail)) return accountSyncCacheUnavailableMessage;
  if (typeof error === 'string' && error.startsWith('资料还在这台电脑上')) return error;
  return '资料还在这台电脑上，暂时没查到账号同步的结果。工作台会自动再试，你可以继续工作。';
}
