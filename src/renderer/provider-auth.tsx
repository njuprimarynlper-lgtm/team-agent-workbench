import { contextualError } from './contextual-error';
import { ErrorLogLink } from './error-notice';
import React, { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { Provider, ProviderAuth, SessionNetworkRoute } from '../shared/types';
import { uiErrorMessage } from '../shared/user-failure';

export const authLabels: Record<ProviderAuth['status'], string> = {
  unknown: '尚未检测', checking: '检测中', authenticated: '已登录', configured: '凭据已配置',
  unauthenticated: '未登录', error: '检测失败', 'not-required': '无需 OpenAI 登录', 'logging-in': '等待登录',
};
export const canUseProvider = (auth?: ProviderAuth) => auth && ['authenticated', 'configured', 'not-required'].includes(auth.status);
export function ProviderAuthPanel({ provider, auth, cwd, autoCheck = true, stale = false, connectionUnverified = false, beforeAction, checked, disabled = false, networkRoute, api = window.workbench }: {
  api?: import('../shared/types').WorkbenchAPI; provider: Provider; auth: ProviderAuth; cwd?: string; autoCheck?: boolean; stale?: boolean; connectionUnverified?: boolean; beforeAction?: () => Promise<unknown>; checked?: (auth: ProviderAuth) => void; disabled?: boolean; networkRoute?: SessionNetworkRoute;
}) {
  const [error, setError] = useState(''), [pending, setPending] = useState(false);
  const name = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude Code' : 'Cursor';
  const current: ProviderAuth = connectionUnverified ? { status: 'unknown', detail: '以前的登录信息仍保留。' } : stale || (auth.status !== 'logging-in' && cwd && auth.cwd !== cwd) ? { status: 'unknown', detail: '当前程序和目录还没检测登录，请点“重新检测”。' } : auth;
  const busy = disabled || pending || ['checking', 'logging-in'].includes(current.status);
  const action = async (kind: 'provider.auth' | 'provider.login' | 'provider.login.cancel') => {
    setError(''); setPending(true);
    try { await beforeAction?.(); const result = await api.call<ProviderAuth>(kind, { provider, cwd, ...(networkRoute ? { networkRoute } : {}) }); if (kind === 'provider.auth' && result?.status) checked?.(result); }
    catch (error) { setError(contextualError(error, { domain: 'cli', operation: kind === 'provider.login' ? '打开个人账号登录' : kind === 'provider.login.cancel' ? '取消登录' : '检测个人账号登录', provider }, { FILE_ACCESS_DENIED: `${name} 登录窗口没有打开：Windows 不允许运行这个程序。请在上方重新选择程序，再点“登录个人账号”。`, OPERATION_TIMEOUT: `${name} 没有返回登录检测结果。点“重新检测”再试，不必重复登录。`, UNCLASSIFIED_FAILURE: `这次没有完成 ${name} 登录检测。点“重新检测”再试。` })); }
    finally { setPending(false); }
  };
  useEffect(() => {
    if (!autoCheck || stale) return;
    const timer = setTimeout(() => { void action('provider.auth'); }, 300);
    return () => clearTimeout(timer);
  }, [provider, cwd, networkRoute, autoCheck, stale]);
  return <section className={'provider-auth auth-' + current.status} aria-label={name + ' 登录状态'}>
    <div className="row"><strong>{name} 账号</strong><span className={'badge ' + (current.connectionIssue ? 'error' : canUseProvider(current) ? 'done' : current.status === 'error' || current.status === 'unauthenticated' ? 'error' : 'running')}>{connectionUnverified ? '本次未测出结果' : current.verifiedLocally && current.status === 'authenticated' ? '已保存登录' : authLabels[current.status]}</span></div>
    {(connectionUnverified || current.verifiedLocally || !['authenticated', 'unknown', 'checking'].includes(current.status)) && <p>{uiErrorMessage(current.detail, { domain: 'cli', provider })}{current.status === 'error' && <ErrorLogLink message={current.detail}/>}</p>}
    {current.connectionIssue && <p className="inline-error" role="status">服务连接暂不可用：{uiErrorMessage(current.connectionIssue, { domain: 'model', provider })}</p>}
    {canUseProvider(current) && (current.identity || !current.verifiedLocally) && <p className="account-identity"><strong>{current.identity || '此程序没有提供账号名称'}</strong>{current.plan && <span className="badge">{current.plan}</span>}</p>}
    {error && <div className="inline-error" role="alert">{error} <ErrorLogLink message={error}/></div>}
    <div className="row auth-actions">
      {current.status !== 'logging-in' && <button className="secondary compact" disabled={busy || !!canUseProvider(current)} title={canUseProvider(current) ? '已沿用当前账号，无需重复登录' : undefined} onClick={() => void action('provider.login')}><ExternalLink size={14}/>登录个人账号</button>}
      <button className="secondary compact" disabled={busy} onClick={() => void action('provider.auth')}><RefreshCw size={14} className={current.status === 'checking' ? 'spin' : ''}/>重新检测</button>
      {current.status === 'logging-in' && <>
        {current.loginUrl && <button className="secondary compact" onClick={() => void api.call('open.link', current.loginUrl).catch(e => setError(uiErrorMessage(e, { domain: 'cli' })))}>打开登录网页</button>}
        <button className="text-button" onClick={() => void action('provider.login.cancel')}>取消登录</button>
      </>}
    </div>
  </section>;
}
