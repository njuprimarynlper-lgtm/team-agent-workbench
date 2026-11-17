import { z } from 'zod';

export const cliConnectionSchema = z.object({
  state: z.enum(['connecting', 'reconnecting', 'connected', 'failed', 'stopped']),
  kind: z.enum(['network', 'authentication', 'forbidden', 'rate_limit', 'service', 'unknown']).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  attempt: z.number().int().min(1).max(10000).optional(),
  retryLimit: z.number().int().min(1).max(10000).optional(),
});
export type CliConnection = z.infer<typeof cliConnectionSchema> & { at: string };
export const cliReportSchema = z.object({
  clientId: z.string().uuid(), sessionId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  provider: z.enum(['codex', 'cursor', 'claude']), connection: cliConnectionSchema,
});
export type CliConnectionReport = z.infer<typeof cliReportSchema> & { username: string; address: string; updatedAt: string };

export function cliConnectionLabel(value: Pick<CliConnection, 'state' | 'kind' | 'httpStatus' | 'attempt' | 'retryLimit'>) {
  const reason = value.kind === 'authentication' || value.httpStatus === 401 ? '登录验证失败' : value.kind === 'forbidden' || value.httpStatus === 403 ? '服务拒绝访问' : value.kind === 'rate_limit' || value.httpStatus === 429 ? '请求暂时受限' : value.kind === 'network' ? '网络异常' : value.kind === 'service' || value.httpStatus && value.httpStatus >= 500 ? '模型服务异常' : '';
  if (value.state === 'reconnecting') return `CLI 正在重连${reason ? ' · ' + reason : ''}`;
  if (value.state === 'failed') return reason ? `${reason} · CLI 请求失败` : 'CLI 请求失败';
  return value.state === 'connecting' ? '等待 CLI 服务响应' : value.state === 'stopped' ? '已停止' : 'CLI 服务已响应';
}
export function cliConnectionAdvice(value: Pick<CliConnection, 'kind' | 'state' | 'httpStatus'>) {
  const retry = value.state === 'reconnecting' ? '工作台会自动重试；你也可以点输入框右下角的停止按钮。' : '';
  const advice = value.httpStatus === 403 || value.kind === 'forbidden' ? '打开“网络与登录”检查账号和连接方式，或换一个可用模型。'
    : value.httpStatus === 401 || value.kind === 'authentication' ? '打开“网络与登录”，点“重新检测连接与登录”检查账号。'
    : value.httpStatus === 429 || value.kind === 'rate_limit' ? '请求频率或额度受限，请稍后重试并检查账号额度。'
    : value.kind === 'network' ? '请在“网络与登录设置”检查此会话的网络出口。'
    : value.kind === 'service' || value.httpStatus && value.httpStatus >= 500 ? '模型服务暂时不可用，请稍后重试。'
    : value.state === 'failed' ? '这次连接没有成功，任务还没完成。可打开网络与登录检查连接。' : '';
  return [retry, advice].filter(Boolean).join('');
}
