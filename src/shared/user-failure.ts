import { parseGuardNetworkProblem, type GuardNetworkProblem } from './guard-network';
/** Public failure metadata. Technical errors remain in diagnostic logs. */
export type FailureRecovery = 'retry' | 'refresh-state' | 'reconnect-central' | 'cli-login' | 'open-settings' | 'check-reply' | 'contact-admin';
export interface UserFailure {
  version: 1;
  code: string;
  operation?: string;
  message: string;
  recovery?: FailureRecovery;
  logRef?: { operationId?: string; id?: string };
  outcome?: 'not-started' | 'accepted' | 'partial' | 'unknown';
  phase?: string;
  networkProblem?: GuardNetworkProblem;
}
export interface FailureContext {
  domain?: 'central' | 'cli' | 'model' | 'relay' | 'desktop' | 'local' | 'transfer' | 'admin' | 'logs';
  operation?: string;
  provider?: string;
  phase?: string;
  outcome?: UserFailure['outcome'];
  logRef?: UserFailure['logRef'];
}
const rawMessage = (error: unknown): string => error instanceof Error ? error.message : typeof error === 'string' ? error : typeof (error as any)?.message === 'string' ? (error as any).message : '';
const knownBusinessText = (message: string) => /[\u4e00-\u9fff]/.test(message)
  && !/\bE[A-Z]{2,}\b/.test(message)
  && !/\b(?:Error:|TypeError|Traceback|stack|Bearer)\b|\[Errno\s|[A-Za-z]:[\\/]|(?:^|[\s："'])(?:\/(?:home|srv|tmp|var|usr|opt)\/)|\[MEMBER_|\[WB_NET|PASSWORD_CHANGE_REQUIRED|(?:password|token|secret|authorization)\s*[:=]|\bat\s+\S+\([^)]*:\d+|\b(?:initialize|turn\/start|session\/\w+)\s*超时|stderr|退出码.*\n/i.test(message)
  && message.length <= 450;
const providerName = (provider?: string) => ({ codex: 'Codex', cursor: 'Cursor', claude: 'Claude Code' } as Record<string, string>)[provider || ''] || 'AI';
const publicOperation = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 128 && !/[\r\n]/.test(value) && (knownBusinessText(value) || /^[\w.:-]{1,128}$/.test(value)) ? value : undefined;
const isRead = (context: FailureContext) => /^(读取|查看|查询|刷新|检测|检查|预览|加载|打开|选择)/.test(context.operation || '') || /(?:^|\.)(?:list|read|query|catalog|status|detect|preview|historyPage|transcriptPage)$/.test(context.phase || '');
const legacySharedReadTimeout = (message: string, context: FailureContext) => isRead(context) && message === '共享 Codex 操作未能确认完成；请核对已有回复，避免重复发送';
function noResponse(context: FailureContext, interrupted = false) {
  const operation = context.operation && !/^(执行此操作|处理会话|处理项目设置|处理项目任务)$/.test(context.operation) ? context.operation : '这次操作';
  if (/^(?:personal:)?(?:remote\.connect|connect)$/.test(context.phase || '')) return interrupted
    ? '连接中央节点时断开了，工作台还没连上。请重新连接。'
    : '中央节点没有及时回应，工作台还没连上。请检查网络后重新连接。';
  if (context.outcome === 'not-started') return `${operation}还没开始，程序没有及时回应。请重试。`;
  if (isRead(context)) return `${operation}没有返回结果。请重新读取；仍失败时可查看日志。`;
  if (/assignment\.create/.test(context.phase || '')) return '还不知道任务是否已派发。先刷新任务列表，暂时不要再次派发。';
  if (/(?:session|sidechat)\.(?:send|steer)|提交消息|发送消息|提交本轮补充/.test((context.phase || '') + ' ' + operation)) return '还不知道这条消息是否已发出。先查看此会话的最后一条消息，暂时不要重发。';
  if (/(?:session\.)?plan\.(?:execute|revise)|提交计划/.test((context.phase || '') + ' ' + operation)) return '还不知道计划是否已开始执行。先查看本会话的执行进展，暂时不要再次执行。';
  return `${operation}有没有完成，还没收到确认。请先查看本次日志，暂时不要重复提交。`;
}
export function userFailure(error: unknown, context: FailureContext = {}): UserFailure {
  const prior = (error as any)?.failure;
  const existing = prior?.version === 1 && legacySharedReadTimeout(prior.message, context)
    ? { ...prior, code: 'OPERATION_TIMEOUT', message: noResponse(context), recovery: 'refresh-state' }
    : prior;
  const operation = publicOperation(existing?.operation) || publicOperation(context.operation);
  if (existing?.version === 1 && typeof existing.message === 'string' && knownBusinessText(existing.message) && /^[A-Z][A-Z0-9_]{2,80}$/.test(existing.code)) {
    const ref = context.logRef || existing.logRef;
    return { version: 1, code: existing.code, message: existing.message, ...(operation ? { operation } : {}), ...(ref ? { logRef: { ...(typeof ref.id === 'string' && /^[a-f0-9-]{1,64}$/i.test(ref.id) ? { id: ref.id } : {}), ...(typeof ref.operationId === 'string' && /^[\w.:-]{1,128}$/.test(ref.operationId) ? { operationId: ref.operationId } : {}) } } : {}), ...(['not-started','accepted','partial','unknown'].includes(existing.outcome) ? { outcome: existing.outcome } : {}), ...(typeof existing.phase === 'string' && /^[\w./:-]{1,128}$/.test(existing.phase) ? { phase: existing.phase } : {}), ...(['retry','refresh-state','reconnect-central','cli-login','open-settings','check-reply','contact-admin'].includes(existing.recovery) ? { recovery: existing.recovery } : {}), ...(existing.networkProblem && ['certificate','proxy_connect','target_tls','upstream'].includes(existing.networkProblem.stage) && typeof existing.networkProblem.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(existing.networkProblem.code) ? { networkProblem: { stage: existing.networkProblem.stage, code: existing.networkProblem.code, viaProxy: existing.networkProblem.viaProxy === true } } : {}) };
  }
  let message = rawMessage(error); const value = error as any;
  const marker = /^\[(MEMBER_[A-Z_]+)\]\s*/.exec(message);
  if (marker) message = message.slice(marker[0].length);
  const errno = String(value?.code || value?.cause?.code || marker?.[1] || '');
  const base = { version: 1 as const, ...(operation ? { operation } : {}), ...(context.phase ? { phase: context.phase } : {}), ...(context.outcome ? { outcome: context.outcome } : {}), ...(context.logRef ? { logRef: context.logRef } : {}) };
  const result = (code: string, text: string, recovery?: FailureRecovery): UserFailure => ({ ...base, code, message: text, ...(recovery ? { recovery } : {}) });
  const prefix = context.operation ? context.operation.replace(/[。；：\s]+$/, '') + '：' : '';
  const connectingCentral = /^(?:personal:)?(?:remote\.connect|connect)$/.test(context.phase || '');
  if (legacySharedReadTimeout(message, context)) return result('OPERATION_TIMEOUT', noResponse(context), 'refresh-state');
  if (/CLI\s*路径无效|未找到.*CLI|尚未安装.*CLI|CLI.*程序路径.*无效/i.test(message)) return result('CLI_PATH_INVALID', `找不到本机${context.provider ? ' ' + providerName(context.provider) : ' AI'} 程序。请到“agent管理”重新检测或选择程序位置。`, 'open-settings');
  if (/CLI (?:进程已退出|连接已关闭)|process.*(?:exit|terminated)|terminated unexpectedly/i.test(message)) return result('CLI_CONNECTION_CLOSED', `${providerName(context.provider)} 的本机连接已断开，暂时收不到后续回复。先查看这轮已有回复，再恢复会话连接。`, 'check-reply');
  if (/本地.*(?:无法读取|读取失败|格式损坏)|本机.*(?:资料|记录).*(?:无法读取|读取失败)/.test(message)) return result('LOCAL_DATA_UNREADABLE', '读不到这台电脑上的会话记录。请保留原文件，把日志交给维护人员排查。', 'contact-admin');
  if (/PASSWORD_CHANGE_REQUIRED/.test(message) || errno === 'PASSWORD_CHANGE_REQUIRED') return result('PASSWORD_CHANGE_REQUIRED', '这是首次登录，请先设置新密码。', 'reconnect-central');
  if (/server.*(?:identity|fingerprint)|服务器身份.*(?:变化|改变|不一致)|指纹.*(?:变化|不一致)/i.test(message)) return result('CENTRAL_IDENTITY_CHANGED', '中央节点的身份与上次不同，连接已停止。请先向管理员确认服务器是否更换，再继续连接。', 'reconnect-central');
  if (/All configured authentication methods failed|client-authentication|Permission denied.*publickey/i.test(message) || value?.level === 'client-authentication' || /Authentication failed/i.test(message) && ['central','admin'].includes(context.domain || '')) return result('CENTRAL_AUTH_REJECTED', '中央节点登录没通过。请检查账号和密码后重新连接。', 'reconnect-central');
  if (/Authentication failed/i.test(message)) return context.domain === 'relay' ? result('RELAY_AUTH_REJECTED', '管理端连不上它配置的代理：代理账号验证没通过。请管理员检查代理账号和密码。', 'open-settings') : result('MODEL_AUTH_REJECTED', `${providerName(context.provider)} 账号验证没通过。请在“网络与登录设置”重新检测登录。`, 'cli-login');
  const networkProblem = parseGuardNetworkProblem(message);
  if (networkProblem) return { ...result('MODEL_NETWORK_CONFIGURATION', `${providerName(context.provider)} 连接不上模型服务。请在“网络与登录设置”检查本次使用的网络。`, 'open-settings'), networkProblem };
  if (/没有此项目的访问权限|模拟权限拒绝：不属于此项目|当前账号未启用或不属于此团队|账号已停用或身份已改变|模拟权限拒绝：账号已停用/.test(message)) return result('PROJECT_ACCESS_REVOKED', message, 'refresh-state');
  if (/^项目已删除$|^项目不存在$|^项目入口不存在$/.test(message)) return result('PROJECT_DELETED', message, 'refresh-state');
  if (/Linux 账号已存在/.test(message)) return result('EXISTING_ACCOUNT_COLLISION', '这个账号在服务器上已经存在。请用“接入已有账号”继续，不必再创建。', 'open-settings');
  if (/\bENOSPC\b|no space left on device|磁盘空间不足/i.test(message) || errno === 'ENOSPC') return result('STORAGE_FULL', prefix + (context.domain === 'local' ? '这台电脑的磁盘空间不足，没能保存。请清理空间后重试。' : '没有足够空间完成保存。请根据日志找到空间不足的位置，再清理后重试。'), 'retry');
  if (/\bEADDRINUSE\b|address already in use/i.test(message) || errno === 'EADDRINUSE') return result('RELAY_PORT_IN_USE', '管理端转发没能启动：端口被其他程序占用了。请在“网络出口”换一个端口。', 'open-settings');
  if (/\bENOENT\b|no such file or directory/i.test(message) || errno === 'ENOENT') return result('FILE_MISSING', prefix + (context.domain === 'local' ? '需要的本机文件找不到了。请重新选择文件或目录。' : '文件找不到了。请刷新列表，确认文件是否已移动或删除。'), 'refresh-state');
  if (/\b(?:EACCES|EPERM)\b|operation not permitted/i.test(message) || ['EACCES', 'EPERM'].includes(errno)) return result('FILE_ACCESS_DENIED', prefix + (context.domain === 'local' ? '工作台无法读写本机文件。请查看日志中的文件位置，并检查该文件的访问权限。' : '这个文件暂时无法访问。请把日志交给管理员检查文件权限。'), 'open-settings');
  if (/\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b|getaddrinfo|connect ECONN/i.test(message) || ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(errno)) return result('CONNECTION_UNAVAILABLE', context.domain === 'central' || context.domain === 'admin'
    ? /ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(message + errno) ? '找不到中央节点的服务器地址。请核对地址，并检查网络连接。' : /ECONNREFUSED/.test(message + errno) ? '连接中央节点时被拒绝了。请先核对服务器地址和端口；填写无误时，请服务器管理员检查服务是否正常。' : '连不上中央节点。请检查服务器地址、端口和网络后重新连接。'
    : context.domain === 'relay' ? '连不上管理端。请确认管理端正在运行，并检查接入码。' : `${providerName(context.provider)} 连接不上模型服务。请检查此会话的网络设置。`, context.domain === 'central' || context.domain === 'admin' ? 'reconnect-central' : 'open-settings');
  if (/\b(?:ECONNRESET|EPIPE)\b|socket hang up/i.test(message) || ['ECONNRESET', 'EPIPE'].includes(errno)) return result('CONNECTION_INTERRUPTED', noResponse(context, true), connectingCentral ? 'reconnect-central' : 'refresh-state');
  if (context.domain === 'relay' && /(?:HTTP\s*|status(?:Code)?[\s:=]*)(?:401|403|429)\b/i.test(message)) return result('RELAY_REQUEST_REJECTED', '管理端没能通过这次网络检测。请检查接入码；仍不通时，让管理员检查代理设置。', 'open-settings');
  if (/(?:HTTP\s*|status(?:Code)?[\s:=]*)(?:401)\b/i.test(message) || value?.httpStatus === 401) return result('MODEL_AUTH_REJECTED', `${providerName(context.provider)} 的登录验证没通过。请在“网络与登录设置”重新检测账号。`, 'cli-login');
  if (/(?:HTTP\s*|status(?:Code)?[\s:=]*)(?:403)\b/i.test(message) || value?.httpStatus === 403) return result('MODEL_ACCESS_REJECTED', `${providerName(context.provider)} 的模型服务拒绝了本次请求。请在“网络与登录设置”检查账号、模型和网络。`, 'open-settings');
  if (/(?:HTTP\s*|status(?:Code)?[\s:=]*)(?:429)\b/i.test(message) || value?.httpStatus === 429) return result('MODEL_REQUEST_LIMITED', '请求太频繁或账号额度不足。请先查看额度，稍后再试。', 'open-settings');
  if (/timeout|timed out|ETIMEDOUT|超时/i.test(message) && !knownBusinessText(message)) return result('OPERATION_TIMEOUT', noResponse(context), connectingCentral ? 'reconnect-central' : 'refresh-state');
  if (knownBusinessText(message)) return result(/^[A-Z][A-Z0-9_]{2,80}$/.test(errno) ? errno : 'BUSINESS_RULE', message);
  if (/abort|cancel|已取消/i.test(message)) return result('OPERATION_CANCELED', '操作已取消。');
  return result('UNCLASSIFIED_FAILURE', connectingCentral ? '工作台还没连上中央节点。请重试连接；仍失败时，把日志交给管理员。' : isRead(context) ? `${context.operation || '读取内容'}失败。请重试读取；仍失败时可查看日志。` : noResponse(context));
}
export function failureError(failure: UserFailure): Error & { code: string; failure: UserFailure } {
  return Object.assign(new Error(failure.message), { code: failure.code, failure });
}
export function uiErrorMessage(error: unknown, context?: FailureContext) { return userFailure(error, context).message; }
