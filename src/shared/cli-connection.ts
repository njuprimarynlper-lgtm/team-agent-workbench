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
  const reason = value.httpStatus ? `HTTP ${value.httpStatus}` : value.kind === 'authentication' ? '登录失效' : value.kind === 'network' ? '网络异常' : value.kind === 'rate_limit' ? '请求受限' : value.kind === 'service' ? '服务异常' : '';
  const attempt = value.attempt ? `（${value.attempt}${value.retryLimit ? '/' + value.retryLimit : ''}）` : '';
  if (value.state === 'reconnecting') return `CLI 正在重连${attempt}${reason ? ' · ' + reason : ''}`;
  if (value.state === 'failed') return reason ? `${reason} · CLI 请求失败` : 'CLI 请求失败';
  return value.state === 'connecting' ? '等待 CLI 服务响应' : value.state === 'stopped' ? '已停止' : 'CLI 服务已响应';
}
export function cliConnectionAdvice(value: Pick<CliConnection, 'kind' | 'state' | 'httpStatus'>) {
  if (value.state === 'reconnecting') return 'CLI 正在自动重试，当前任务尚未完成；也可以停止任务。';
  if (value.httpStatus === 403 || value.kind === 'forbidden') return '服务拒绝访问，请检查账号权限、所选模型和网络出口。';
  if (value.kind === 'authentication') return '请重新检查 CLI 登录状态。';
  if (value.kind === 'rate_limit') return '请求频率或额度受限，请稍后重试并检查额度。';
  if (value.kind === 'network') return '请检查网络与管理端出口。';
  return value.state === 'failed' ? '请查看运行信息，确认后重试。' : '';
}
