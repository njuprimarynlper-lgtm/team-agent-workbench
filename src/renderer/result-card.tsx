import { MenuDetails } from './menu-details';
import React, { useId, useRef, useState } from 'react';
import { Check, ChevronDown, Pencil, X } from 'lucide-react';

export interface ResultAlias { value: string; original: string; save: (value: string) => Promise<void> }
export function ResultAliasEditor({ alias, disabled }: { alias: ResultAlias; disabled?: boolean }) {
  const [editing, setEditing] = useState(false), [value, setValue] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const running = useRef(false), trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setEditing(false); setError(''); trigger.current?.focus(); };
  const save = async () => {
    if (running.current) return; running.current = true; setSaving(true); setError('');
    try { await alias.save(value.trim()); close(); } catch (reason: any) { setError(reason.message || '别名未保存，请重试'); } finally { running.current = false; setSaving(false); }
  };
  return <span className="result-alias-control"><button ref={trigger} type="button" className="icon result-alias-pencil" aria-label={`修改本地别名：${alias.original}`} title="修改本地别名，仅自己可见" disabled={disabled || saving} onClick={() => { setValue(alias.value); setError(''); setEditing(true); }}><Pencil size={13}/></button>{editing && <span className="result-alias-inline" role="group" aria-label="编辑本地别名"><input autoFocus aria-label="成果本地别名" value={value} maxLength={200} disabled={saving} placeholder={alias.original} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!saving) close(); } if (event.key === 'Enter') { event.preventDefault(); void save(); } }}/><button type="button" className="icon" aria-label="保存本地别名" disabled={saving} onClick={() => void save()}><Check size={14}/></button><button type="button" className="icon" aria-label="取消修改别名" disabled={saving} onClick={close}><X size={14}/></button><small>仅自己可见，留空恢复原名</small>{error && <span className="inline-error" role="alert">{error}</span>}</span>}</span>;
}

export function ResultMoreMenu({ children, disabled = false }: { children: React.ReactNode; disabled?: boolean }) {
  return <MenuDetails className="result-more" onClick={event => { const menu = event.currentTarget; const button = (event.target as HTMLElement).closest('button'); if (button && !button.disabled && !button.closest('[data-menu-keep-open]')) menu.open = false; }}>
    <summary className="secondary compact" aria-disabled={disabled || undefined} onClick={event => { if (disabled) event.preventDefault(); }}>更多</summary>
    <div className="result-more-menu" role="menu">{children}</div>
  </MenuDetails>;
}

export function ResultCard({ id, title, badges, metadata, preview, expanded, selected, disabled, toggle, selection, children, actions, notice, completed = false, alias }: {
  id: string; title: string; badges: React.ReactNode; metadata: React.ReactNode; preview: string;
  expanded: boolean; selected?: boolean; disabled?: boolean; completed?: boolean; toggle: () => void;
  selection?: React.ReactNode; children?: React.ReactNode; actions: React.ReactNode;
  notice?: React.ReactNode;
  alias?: ResultAlias;
}) {
  const detailId = useId();
  return <article className={'content-card result-card' + (completed ? ' result-completed' : '') + (expanded ? ' is-expanded' : '') + (selected ? ' merge-selected' : '')} data-result-id={id}>
    <div className="result-card-top">
      {selection && <div className="result-card-selection">{selection}</div>}
      <div className="content-card-summary result-card-summary" onClick={event => { if (!disabled && !(event.target as HTMLElement).closest('button, input, .result-alias-control')) toggle(); }}><div className="result-card-heading">
        <button type="button" className="result-card-title-toggle result-card-toggle" aria-expanded={expanded} aria-controls={expanded ? detailId : undefined} disabled={disabled} onClick={toggle}><b title={title}>{title}</b></button>
        {alias && <ResultAliasEditor alias={alias} disabled={disabled}/>}<span className="result-card-badges">{badges}</span><button type="button" className="icon result-card-expand" aria-label={expanded ? '收起成果详情' : '展开成果详情'} aria-expanded={expanded} disabled={disabled} onClick={toggle}><ChevronDown size={16} aria-hidden="true"/></button>
      </div><button type="button" className="result-card-overview result-card-overview-toggle" aria-expanded={expanded} disabled={disabled} onClick={toggle}>{!expanded && <span className="result-card-preview">{preview}</span>}<span className="result-card-meta">{metadata}</span></button></div>
      <div className="content-card-actions result-card-actions">{actions}</div>
    </div>
    {notice && <p className="result-card-notice" role="status">{notice}</p>}
    {expanded && <div className="result-card-details" id={detailId} role="region" aria-label={`${title}详情`}>{children}</div>}
  </article>;
}
