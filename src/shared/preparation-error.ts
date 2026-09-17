export function preparationErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/^(网络连接中断|CLI 登录已失效|CLI 意外停止|未能完成整理)/.test(message)) return message;
  if (/network|timeout|timed out|connection|econn|fetch/i.test(message)) return '网络连接中断，未能完成整理。请检查网络后重试。';
  if (/unauth|log\s*in|login|credential|登录/i.test(message)) return 'CLI 登录已失效，未能完成整理。请重新登录后重试。';
  if (/进程已退出|process.*exit|terminated|crash/i.test(message)) return 'CLI 意外停止，未能完成整理。请重试；若仍失败，请检查本机 CLI。';
  if (/格式不完整|等待超时|已中断/.test(message)) return message;
  return '未能完成整理。请重试；若仍失败，请检查网络和 CLI 状态。';
}
