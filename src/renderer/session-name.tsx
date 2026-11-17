import { contextualError } from './contextual-error';
import { ErrorLogLink } from './error-notice';
import { uiErrorMessage } from '../shared/user-failure';
import React, { useEffect, useId, useRef, useState } from 'react';

/** Keep the editor in place so renaming never takes the user away from the chat. */
export function SessionName({ title, save, variant = 'heading', children }: {
  title: string; save: (title: string) => Promise<void>;
  variant?: 'heading' | 'sidebar' | 'subsession';
  children?: (begin: () => void) => React.ReactNode;
}) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null), editingRef = useRef(false), saving = useRef(false);
  const composing = useRef(false), errorId = useId();
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  const begin = () => {
    if (editingRef.current) return;
    editingRef.current = true; setDraft(title); setError(''); setEditing(true);
  };
  const finish = () => { editingRef.current = false; setEditing(false); setError(''); };
  const commit = async () => {
    // Enter may be followed by blur; both must share one save operation.
    if (!editingRef.current || saving.current || composing.current) return;
    const next = draft.trim();
    if (!next) { setError('会话名称不能为空'); return; }
    if (next === title) { finish(); return; }
    saving.current = true; setBusy(true); setError('');
    try { await save(next); finish(); }
    catch (reason) { setError(contextualError(reason, { domain: 'local', operation: '保存会话名称' }, { FILE_ACCESS_DENIED: '名称没存下来：Windows 不允许写入会话记录。新名称还在输入框里。点“查看日志”，请管理员检查记录文件的写入权限；处理好后按回车重试。', UNCLASSIFIED_FAILURE: '这个名称还没保存。输入内容保留，按回车可以再试，按 Esc 放弃修改。' })); }
    finally { saving.current = false; setBusy(false); }
  };
  return <div className={'session-name session-name-' + variant} onKeyDown={event => {
    if (!editing && event.key === 'F2') { event.preventDefault(); event.stopPropagation(); begin(); }
  }}>
    {editing ? <div className="session-name-editor" aria-busy={busy}>
      <input ref={input} aria-label="会话名称" title="回车保存，Esc 取消" maxLength={120}
        value={draft} readOnly={busy} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
        onChange={event => { setDraft(event.target.value); setError(''); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onBlur={() => void commit()} onKeyDown={event => {
          event.stopPropagation();
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Enter') { event.preventDefault(); void commit(); }
          if (event.key === 'Escape') { event.preventDefault(); if (!saving.current) finish(); }
        }}/>
      {busy && <span className="session-name-saving" role="status">保存中…</span>}
      {error && <span id={errorId} className="session-name-error" role="alert">{error} <ErrorLogLink message={error}/></span>}
    </div> : children ? children(begin) : <button type="button" className="session-name-label" title={title + ' · 点击修改名称'} aria-label={'修改会话名称：' + title} onClick={begin}>{title}</button>}
  </div>;
}
