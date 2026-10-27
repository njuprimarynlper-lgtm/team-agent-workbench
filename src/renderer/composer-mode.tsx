import { usePopupDismiss } from './popup-dismiss';
import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, RefreshCw } from 'lucide-react';
import { modeOption, type SessionMode, type SessionModeCatalog } from '../shared/session-mode';
import type { AgentSession } from '../shared/types';

export function ComposerMode({ session }: { session: AgentSession }) {
  const [open, setOpen] = useState(false), [catalog, setCatalog] = useState<SessionModeCatalog>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null), generation = useRef(0);
  const load = async () => {
    const n = ++generation.current; setBusy(true); setError('');
    try { const value = await window.workbench.call<SessionModeCatalog>('session.modes', { id: session.id }); if (n === generation.current) setCatalog(value); return value; }
    catch { if (n === generation.current) setError('模式读取失败，请重试。'); }
    finally { if (n === generation.current) setBusy(false); }
  };
  const apply = async (mode: SessionMode) => {
    setBusy(true); setError('');
    try { await window.workbench.call('session.mode', { id: session.id, mode }); setOpen(false); }
    catch (e: any) { setError(e.message || '模式未切换，请重试。'); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (open && !catalog) void load(); }, [open]);
  useEffect(() => () => { generation.current++; }, [session.id]);
  usePopupDismiss(open, root, reason => { setOpen(false); if (reason === 'escape') root.current?.querySelector('button')?.focus(); });
  return <div className="composer-mode" ref={root}><button className="composer-setting" aria-label="选择对话模式" aria-expanded={open} disabled={busy || session.status === 'starting'} onClick={() => setOpen(!open)}>{modeOption(session.mode || 'default').name}<ChevronDown size={12}/></button>
    {open && <section className="composer-popover" role="dialog" aria-label="对话模式"><header><strong>对话模式</strong><span className="spacer"/><button className="icon" aria-label="刷新模式" disabled={busy} onClick={() => void load()}><RefreshCw size={14}/></button></header><div className="composer-options">
      {busy && <p role="status">读取中…</p>}{(error || catalog?.error) && <p role="alert" className="inline-error">{error || catalog?.error}</p>}
      {catalog?.modes.map(mode => <button className="setting-option" key={mode.id} aria-pressed={(session.mode || 'default') === mode.id} disabled={busy} onClick={() => void apply(mode.id)}><span>{mode.name}<small>{mode.description}</small></span>{(session.mode || 'default') === mode.id && <Check size={14}/>}</button>)}
      {['running', 'approval'].includes(session.status) && <p className="muted small">当前回复继续；新模式从下一轮生效。</p>}
    </div></section>}
  </div>;
}
