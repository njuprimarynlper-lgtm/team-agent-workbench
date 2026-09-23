import React, { useEffect, useRef, useState } from 'react';
import { Network, RefreshCw } from 'lucide-react';
import type { Provider, ProviderAuth } from '../shared/types';
import type { UserEgressStatus } from '../shared/egress';
import { ProviderAuthPanel } from './provider-auth';
import { checkProviderConnection, type ProviderConnectionCheck } from './provider-connection-check';

export function ProviderConnectionSettings({ provider, cwd, auth, egress, activeTaskCount, busyChanged, pendingChanged, checked, showCatalog = true }: {
  provider: Provider; cwd: string; auth: ProviderAuth; egress?: UserEgressStatus; activeTaskCount: number; busyChanged?: (busy: boolean) => void;
  checked?: (result: ProviderConnectionCheck) => void; pendingChanged?: (pending: boolean) => void; showCatalog?: boolean;
}) {
  const [enabled, setEnabled] = useState(!!egress?.enabled), [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<ProviderConnectionCheck>();
  const sequence = useRef(0), checking = useRef(false);
  const callbacks = useRef({ busyChanged, checked }); callbacks.current = { busyChanged, checked };
  const dirty = enabled !== !!egress?.enabled || !!invite.trim();
  useEffect(() => { pendingChanged?.(dirty); return () => pendingChanged?.(false); }, [dirty]);
  useEffect(() => setEnabled(!!egress?.enabled), [egress?.enabled]);
  const check = async (apply: boolean) => {
    if (!cwd || checking.current) return;
    if (apply && dirty && activeTaskCount) { setError('当前窗口有任务正在运行，请结束或停止任务后再切换网络出口。'); return; }
    checking.current = true; const n = ++sequence.current; setBusy(true); setError(''); setResult(undefined); callbacks.current.busyChanged?.(true);
    try {
      const result = await checkProviderConnection(window.workbench.call, provider, cwd, apply && dirty ? { enabled, inviteCode: invite.trim() || undefined } : undefined, () => n === sequence.current);
      if (n !== sequence.current) return;
      if (apply) setInvite(''); setResult(result); setError(result.issues.join('；')); callbacks.current.checked?.(result);
    } catch (reason: any) { if (n === sequence.current) setError(reason.message); }
    finally { checking.current = false; if (n === sequence.current) { setBusy(false); callbacks.current.busyChanged?.(false); } }
  };
  useEffect(() => {
    const n = ++sequence.current;
    // Opening the panel should not lock network controls behind a slow model request.
    if (cwd) void window.workbench.call('provider.auth', { provider, cwd }).catch((reason: Error) => { if (n === sequence.current) setError(reason.message); });
    return () => { sequence.current++; callbacks.current.busyChanged?.(false); };
  }, [provider, cwd]);
  return <section className="provider-connection-settings" aria-label="网络与登录设置">
    <div className="row"><Network size={17}/><strong>网络连接</strong><span className="spacer"/><span className="muted small">{egress?.enabled ? '管理端出口' : '本机网络'}</span></div>
    <p className="muted small">应用于当前账号窗口的 Codex 和 Cursor 会话，仍使用你的个人 CLI 账号。</p>
    <fieldset disabled={busy}>
      <label className="check-row"><input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); setResult(undefined); setError(''); }}/><span>通过管理端访问 Codex 和 Cursor</span></label>
      {enabled && <label className="field">管理端接入码<textarea aria-label="管理端网络出口接入码" rows={3} value={invite} onChange={event => { setInvite(event.target.value); setResult(undefined); }} placeholder={egress?.hasAccessCode ? '已保存接入码；更换出口时粘贴新的接入码' : '粘贴管理端“网络出口”页面复制的接入码'}/></label>}
    </fieldset>
    {egress?.enabled && <p className="muted small" role="status">{egress.detail}</p>}
    {activeTaskCount > 0 && <p className="muted small">当前有 {activeTaskCount} 个任务运行中，可重新检测；结束或停止后可切换出口。</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <button className="secondary" disabled={busy || !cwd || dirty && (!!activeTaskCount || enabled && !invite.trim() && !egress?.hasAccessCode)} onClick={() => void check(true)}><RefreshCw size={14} className={busy ? 'spin' : ''}/>{busy ? '正在检测网络、登录和模型…' : dirty ? '应用并重新检测' : '重新检测连接与登录'}</button>
    <ProviderAuthPanel provider={provider} cwd={cwd} auth={auth} autoCheck={false} stale={dirty || busy} disabled={dirty || busy}/>
    {showCatalog && result?.catalog && <div className="provider-connection-catalog"><b>可用模型（{result.catalog.models.length}）</b><p>{result.catalog.models.map(model => model.name).join('、') || 'CLI 暂未返回可用模型。'}</p><p className="muted small">{result.catalog.quota.windows.length ? result.catalog.quota.windows.map(window => `${window.name}：剩余 ${Number((100 - window.usedPercent).toFixed(1))}%`).join('；') : result.catalog.quota.detail}</p></div>}
  </section>;
}
