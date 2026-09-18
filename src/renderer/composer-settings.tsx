import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ExternalLink, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { AgentSession, PermissionMode, PermissionReport, ProviderCatalog } from '../shared/types';
import { permissionEffects, permissionLabels, sessionPermissionDescription, sessionPermissionLabel } from '../shared/permission-presentation';

type Choice = { kind: 'model' | 'permission'; value: string; label: string };

export function ComposerSettings({ session }: { session: AgentSession }) {
  const [open, setOpen] = useState<Choice['kind']>(), [catalog, setCatalog] = useState<ProviderCatalog>(), [report, setReport] = useState<PermissionReport>();
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(''), [pending, setPending] = useState<Choice>();
  const root = useRef<HTMLDivElement>(null), modelButton = useRef<HTMLButtonElement>(null), permissionButton = useRef<HTMLButtonElement>(null), sequence = useRef(0);
  const running = ['running', 'approval'].includes(session.status), disabled = session.status === 'starting' || saving;
  const close = () => { setOpen(undefined); setPending(undefined); setError(''); };
  const refresh = async (kind: Choice['kind']) => {
    const n = ++sequence.current; setLoading(true); setError('');
    try {
      const result = await window.workbench.call(kind === 'model' ? 'provider.catalog' : 'provider.permissions', { provider: session.provider, cwd: session.cwd });
      if (n === sequence.current) { if (kind === 'model') setCatalog(result as ProviderCatalog); else setReport(result as PermissionReport); }
    } catch { if (n === sequence.current) setError(kind === 'model' ? '模型与额度读取失败，请检查登录或网络后重试。' : '权限读取失败，请重试。'); }
    finally { if (n === sequence.current) setLoading(false); }
  };
  useEffect(() => { if (open) void refresh(open); return () => { sequence.current++; }; }, [open, session.provider, session.cwd]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!saving && !root.current?.contains(e.target as Node)) close(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) { e.preventDefault(); close(); (open === 'model' ? modelButton : permissionButton).current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, saving]);
  const apply = async (choice: Choice, stop = false) => {
    if (disabled) return;
    if ((choice.kind === 'model' ? session.model : session.permissionMode || 'inherit') === choice.value) { close(); return; }
    if (running && !stop) { setPending(choice); return; }
    setSaving(true); setError('');
    try {
      await window.workbench.call(choice.kind === 'model' ? 'session.model' : 'session.permissions', { id: session.id, ...(choice.kind === 'model' ? { model: choice.value } : { mode: choice.value }), stop });
      close();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };
  const toggle = (kind: Choice['kind']) => { setPending(undefined); setError(''); setOpen(open === kind ? undefined : kind); };
  const modelName = catalog?.models.find(m => m.id === session.model)?.name || session.model || '默认模型';
  const models = catalog?.models || [];
  const selectedModel = session.model || models.find(m => m.isDefault)?.id;
  return <div className="composer-settings" ref={root}>
    <button ref={modelButton} className="composer-setting" aria-label="选择模型" aria-expanded={open === 'model'} aria-haspopup="dialog" title={modelName} disabled={saving} onClick={() => toggle('model')}><span>{modelName}</span><ChevronDown size={12}/></button>
    <button ref={permissionButton} className="composer-setting" aria-label="当前执行权限" aria-expanded={open === 'permission'} aria-haspopup="dialog" title={sessionPermissionDescription(session)} disabled={saving} onClick={() => toggle('permission')}><ShieldCheck size={13}/><span>{sessionPermissionLabel(session)}</span><ChevronDown size={12}/>{session.permissions?.execution === 'blocked' && <span className="permission-restricted" title="部分命令无法执行">!</span>}</button>
    {open && <section className="composer-popover" role="dialog" aria-label={open === 'model' ? '模型与额度' : '执行权限'}>
      <header><strong>{open === 'model' ? (session.provider === 'codex' ? 'Codex' : 'Cursor') + ' · 模型' : '执行权限'}</strong><span className="spacer"/><button className="icon" title="刷新选项" disabled={loading || saving} onClick={() => void refresh(open)}><RefreshCw size={13} className={loading ? 'spin' : ''}/></button><button className="icon" title="关闭选项" disabled={saving} onClick={close}><X size={14}/></button></header>
      <div className="composer-options">
        {loading && <p className="muted small" role="status">读取中…</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {session.status === 'starting' && <p className="muted small">正在启动，完成后可切换。</p>}
        {open === 'model' ? <>
          {session.model && !models.some(m => m.id === session.model) && <div className="current-model">当前：{session.model}</div>}
          {catalog?.modelError && <p className="inline-error" role="alert">{catalog.modelError}</p>}
          {!loading && catalog && !models.length && !catalog.modelError && <p className="muted small">暂未获取可用模型，请刷新重试。</p>}
          <div role="group" aria-label="可用模型">{models.map(m => <button key={m.id} className="setting-option" aria-pressed={selectedModel === m.id} disabled={disabled || loading} onClick={() => void apply({ kind: 'model', value: m.id, label: m.name })}><span>{m.name}{m.isDefault && <small>默认</small>}</span>{selectedModel === m.id && <Check size={14}/>}</button>)}</div>
          <div className="quota-panel"><div className="row"><strong>账号额度</strong><span className="spacer"/><button className="text-button" onClick={() => void window.workbench.call('open.link', session.provider === 'codex' ? 'https://chatgpt.com/codex/settings/usage' : 'https://cursor.com/dashboard/spending').catch(() => setError('无法打开浏览器，请稍后重试。'))}><ExternalLink size={12}/>官方额度页</button></div>
            {!catalog?.quota.windows.length && <p className="muted small">{catalog?.quota.detail || (session.provider === 'cursor' ? '请在官方额度页查看' : '额度未读取')}</p>}
            {catalog?.quota.windows.map((w, i) => <div className="quota-window" key={i}><div className="row"><span>{w.name}{w.windowMinutes ? `（${w.windowMinutes >= 1440 ? w.windowMinutes / 1440 + ' 天' : w.windowMinutes / 60 + ' 小时'}）` : ''}</span><b>剩余 {Number((100 - w.usedPercent).toFixed(1))}%</b></div><progress max={100} value={100 - w.usedPercent}/>{w.resetsAt && <small>重置：{new Date(w.resetsAt * 1000).toLocaleString('zh-CN')}</small>}</div>)}
          </div>
        </> : <>
          <p className="permission-current">{sessionPermissionDescription(session)}</p>
          <div role="group" aria-label="权限选项">{(['inherit', 'review', 'auto', 'full'] as PermissionMode[]).map(mode => {
            const unavailable = session.provider === 'cursor' && mode === 'auto', restricted = !!report?.allowedModes && !report.allowedModes.includes(mode);
            return <button key={mode} className="setting-option" aria-label={permissionLabels[session.provider][mode]} aria-pressed={(session.permissionMode || 'inherit') === mode} disabled={disabled || loading || !report || unavailable || restricted} onClick={() => void apply({ kind: 'permission', value: mode, label: permissionLabels[session.provider][mode] })}><span>{permissionLabels[session.provider][mode]}<small>{unavailable ? '当前接入方式暂不支持' : restricted ? '管理员策略不允许' : permissionEffects[session.provider][mode]}</small></span>{(session.permissionMode || 'inherit') === mode && <Check size={14}/>}</button>;
          })}</div>
          {session.provider === 'cursor' && <details className="cursor-review-config"><summary>配置 Cursor Allowlist</summary><p>清空账号及当前目录的自动允许列表，保留拒绝规则并备份配置。会影响使用同一配置的其他 Cursor CLI 会话。</p><button className="secondary compact" disabled={disabled || running || loading} onClick={async () => { setSaving(true); setError(''); try { setReport(await window.workbench.call<PermissionReport>('provider.cursorReview', { cwd: session.cwd })); } catch (e: any) { setError(e.message); } finally { setSaving(false); } }}>应用 Cursor Allowlist 配置</button></details>}
        </>}
      </div>
      {pending && <footer className="setting-confirm"><p>切换为“{pending.label}”将停止当前任务。已有对话保留，切换后可继续发送。</p><div className="row"><button className="secondary compact" disabled={saving} onClick={() => setPending(undefined)}>取消</button><button className="primary compact" disabled={disabled} onClick={() => void apply(pending, true)}>{saving ? '切换中…' : '停止当前任务并切换'}</button></div></footer>}
    </section>}
  </div>;
}
