import type { AgentSession } from '../shared/types';
import type { CliConnection } from '../shared/cli-connection';

// Inspect only CLI diagnostics/errors; never model text or tool output.
export function classifyCliError(error: unknown, retrying?: boolean): Omit<CliConnection, 'at'> | undefined {
  const object = error && typeof error === 'object' ? error as any : undefined;
  const raw = typeof error === 'string' ? error : typeof object?.message === 'string' ? object.message : typeof object?.error?.message === 'string' ? object.error.message : '';
  const text = raw.slice(-8192).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const info = object?.codexErrorInfo || object?.error?.codexErrorInfo || object?.data?.codexErrorInfo;
  const explicit = object?.httpStatusCode ?? object?.statusCode ?? object?.data?.httpStatusCode ?? object?.data?.statusCode ?? info?.httpConnectionFailed?.httpStatusCode ?? info?.responseStreamDisconnected?.httpStatusCode ?? info?.responseStreamConnectionFailed?.httpStatusCode;
  const match = text.match(/(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?:\s+code)?[\s:="']*)([45]\d{2})\b|\b([45]\d{2})\s+(?:Forbidden|Unauthorized|Too Many Requests|Bad Gateway|Internal Server Error|Service Unavailable)/i);
  const code = Number(explicit ?? match?.[1] ?? match?.[2]), httpStatus = code >= 400 && code <= 599 ? code : undefined;
  const retry = text.match(/(?:reconnect(?:ing)?|retry(?:ing)?|重连|重试)[^\d\r\n]{0,20}(\d+)(?:\s*\/\s*(\d+))?/i);
  const willRetry = retrying ?? /reconnect(?:ing)?|retrying|will retry|正在重连|正在重试/i.test(text);
  let kind: CliConnection['kind'];
  if (httpStatus === 403) kind = 'forbidden';
  else if (httpStatus === 401 || /unauthorized|not logged in|login (?:expired|required)|authentication (?:failed|required)|refresh_token_expired|invalid_grant|token expired|登录.*(?:失效|过期)/i.test(text)) kind = 'authentication';
  else if (httpStatus === 429 || /rate.?limit|quota exceeded/i.test(text)) kind = 'rate_limit';
  else if (httpStatus && httpStatus >= 500) kind = 'service';
  else if (willRetry || /stream (?:disconnected|closed)|connection (?:reset|failed|closed)|network (?:error|unreachable)|error sending request|fetch failed|timed? ?out|ENOTFOUND|ECONN|连接超时|无法连接/i.test(text)) kind = 'network';
  else if (httpStatus) kind = 'unknown';
  if (!kind) return;
  return { state: willRetry ? 'reconnecting' : 'failed', kind, ...(httpStatus ? { httpStatus } : {}),
    ...(retry && Number(retry[1]) > 0 && Number(retry[1]) <= 10000 ? { attempt: Number(retry[1]) } : {}),
    ...(retry?.[2] && Number(retry[2]) > 0 && Number(retry[2]) <= 10000 ? { retryLimit: Number(retry[2]) } : {}) };
}

export class CliConnectionTracker {
  private buffer = '';
  constructor(private session: AgentSession, private changed: () => void, private report?: (value: CliConnection) => void) {}
  set(value: Omit<CliConnection, 'at'>) {
    const previous = this.session.cliConnection;
    if (previous && JSON.stringify({ ...previous, at: undefined }) === JSON.stringify({ ...value, at: undefined })) return;
    this.session.cliConnection = { ...value, at: new Date().toISOString() }; this.changed(); this.report?.(this.session.cliConnection);
  }
  begin() { this.buffer = ''; this.set({ state: 'connecting' }); }
  diagnostic(chunk: string) {
    if (!['running', 'starting'].includes(this.session.status)) return;
    this.buffer = (this.buffer + chunk).slice(-8192);
    const lines = this.buffer.split(/[\r\n]+/); this.buffer = lines.pop() || '';
    for (const line of lines) { const value = classifyCliError(line); if (value) this.set(value); }
    const value = classifyCliError(this.buffer); if (value) this.set(value);
  }
  error(error: unknown, retrying?: boolean) { const value = classifyCliError(error, retrying); if (value) this.set(value); }
  responded() { this.buffer = ''; this.set({ state: 'connected' }); }
  finish(error?: unknown) {
    if (!error) { this.responded(); return; }
    const value = classifyCliError(error, false);
    this.set(value || { ...this.session.cliConnection, state: 'failed', kind: this.session.cliConnection?.kind || 'unknown' });
  }
  stop() { this.buffer = ''; if (this.session.cliConnection?.state !== 'failed') this.set({ state: 'stopped' }); }
}
