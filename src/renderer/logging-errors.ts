export function installRendererErrorCapture(api: { call(action: string, payload?: unknown): Promise<unknown> }) {
  let remaining = 10, resetAt = 0;
  const send = (type: 'error' | 'unhandledrejection', error: unknown) => {
    if (Date.now() >= resetAt) { remaining = 10; resetAt = Date.now() + 60000; }
    if (remaining-- <= 0) return;
    void api.call('logs.rendererError', { type, message: String(error instanceof Error ? error.message : error ?? '未知界面错误').slice(0, 2000), stack: error instanceof Error ? error.stack?.slice(0, 8000) : undefined }).catch(() => {});
  };
  window.addEventListener('error', event => send('error', event.error || event.message));
  window.addEventListener('unhandledrejection', event => send('unhandledrejection', event.reason));
}
