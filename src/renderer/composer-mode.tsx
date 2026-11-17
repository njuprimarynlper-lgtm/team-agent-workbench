import { contextualError, toolName } from './contextual-error';
import { ErrorLogLink } from './error-notice';
import { uiErrorMessage } from '../shared/user-failure';
import { usePopupDismiss } from './popup-dismiss';
import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { modeOption, type SessionMode, type SessionModeCatalog } from '../shared/session-mode';
import type { AgentSession } from '../shared/types';

export function ComposerMode({ session }: { session: AgentSession }) {
  return <SessionComposerMode key={session.id} session={session}/>;
}
function SessionComposerMode({ session }: { session: AgentSession }) {
  const [open, setOpen] = useState(false), [catalog, setCatalog] = useState<SessionModeCatalog>(), [loading, setLoading] = useState(false), [saving, setSaving] = useState<SessionMode>(), [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null), generation = useRef(0);
  const busy = loading || saving !== undefined;
  const close = () => { setOpen(false); };
  const load = async () => {
    const n = ++generation.current; setLoading(true); setError('');
    try { const value = await window.workbench.call<SessionModeCatalog>('session.modes', { id: session.id }); if (n === generation.current) setCatalog(value); return value; }
    catch (error) { if (n === generation.current) setError(contextualError(error, { domain: 'cli', operation: '读取对话模式', provider: session.provider }, { CLI_PATH_INVALID: `找不到本机 ${toolName(session.provider)} 程序，所以没有读到对话模式。关闭面板后，到左下角“agent管理”重新检测。` })); }
    finally { if (n === generation.current) setLoading(false); }
  };
  const apply = async (mode: SessionMode) => {
    if (busy || session.status === 'starting') return;
    if (session.provider === 'cursor' && (session.mode || 'default') === mode) { close(); return; }
    const n = generation.current; setSaving(mode); setError('');
    try { await window.workbench.call('session.mode', { id: session.id, mode }); if (n === generation.current) close(); }
    catch (error) { if (n === generation.current) setError(uiErrorMessage(error, { domain: 'cli', operation: '切换对话模式', provider: session.provider })); }
    finally { if (n === generation.current) setSaving(undefined); }
  };
  useEffect(() => { if (open && !catalog) void load(); }, [open]);
  useEffect(() => () => { generation.current++; }, [session.id]);
  usePopupDismiss(open, root, reason => { setOpen(false); if (reason === 'escape') root.current?.querySelector('button')?.focus(); });
  return <div className="composer-mode" ref={root}><button type="button" className="composer-setting" aria-label="选择对话模式" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>{modeOption(session.mode || 'default').name}{saving !== undefined ? <LoaderCircle size={12} className="spin"/> : <ChevronDown size={12}/>}</button>
    {open && <section className="composer-popover" role="dialog" aria-label="对话模式"><header><strong>对话模式</strong><span className="spacer"/><button type="button" className="icon" aria-label="刷新模式" disabled={busy} onClick={() => void load()}><RefreshCw size={14}/></button><button type="button" className="icon" aria-label="关闭模式选项" onClick={close}><X size={14}/></button></header><div className="composer-options">
      {loading && <p role="status">读取模式…</p>}{saving !== undefined && <p role="status">正在切换为 {modeOption(saving).name}…</p>}{(error || catalog?.error) && <p role="alert" className="inline-error">{error || uiErrorMessage(catalog?.error, { domain: 'cli', operation: '读取对话模式', provider: session.provider })} <ErrorLogLink message={error || catalog?.error}/></p>}
      {catalog?.modes.map(mode => <button type="button" className="setting-option" key={mode.id} aria-pressed={(session.mode || 'default') === mode.id} disabled={busy || session.status === 'starting'} onClick={() => void apply(mode.id)}><span>{mode.name}<small>{mode.description}</small></span>{(session.mode || 'default') === mode.id && <Check size={14}/>}</button>)}
      {session.status === 'starting' && <p className="muted small">正在启动会话，完成后可切换模式。</p>}
      {['running', 'approval'].includes(session.status) && <p className="muted small">当前回复继续；新模式从下一轮生效。</p>}
    </div></section>}
  </div>;
}
