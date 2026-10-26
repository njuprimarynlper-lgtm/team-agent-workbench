import React, { useEffect, useRef, useState } from 'react';
import { CornerUpLeft, Pencil, X, Check, Pause, Play, LoaderCircle } from 'lucide-react';
import type { AgentSession, WorkbenchAPI } from '../shared/types';
import { ContextMenu, contextAnchor, type ContextAnchor } from './context-menu';

function QueuePreview({ text, close }: { text: string; close: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null; button.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="queue-preview" onClick={close} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') { event.preventDefault(); button.current?.focus(); }
  }}><section role="dialog" aria-modal="true" aria-label="待发送消息全文" onClick={event => event.stopPropagation()}><header><b>待发送消息</b><button ref={button} className="icon" aria-label="关闭消息预览" onClick={close}><X size={16}/></button></header><pre>{text}</pre></section></div>;
}

export function SessionInputQueue({ session, activeTurnId, api, changed, locked }: {
  session: AgentSession; activeTurnId?: string; api: WorkbenchAPI; changed: () => Promise<void>; locked?: boolean;
}) {
  const [editing, setEditing] = useState(''), [text, setText] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState(''), [dragging, setDragging] = useState('');
  const [menu, setMenu] = useState<{ anchor: ContextAnchor; id: string }>();
  const queue = session.inputQueue;
  const items = queue?.items.filter(item => !item.submitted) || [];
  if (!queue || !items.length || session.cursorNative) return null;
  const action = async (name: string, extra: object = {}) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await api.call('session.queue.' + name, { id: session.id, ...extra }); setEditing(''); await changed(); }
    catch (reason: any) { setError(reason.message); }
    finally { setBusy(false); }
  };
  const disabled = busy || locked || !!session.closedAt;
  const beginEdit = async (id: string, value: string) => {
    if (disabled) return;
    setBusy(true); setError('');
    try {
      // Editing must not race automatic dispatch at the end of the current turn.
      await api.call('session.queue.pause', { id: session.id });
      await changed(); setEditing(id); setText(value);
    } catch (reason: any) { setError(reason.message); }
    finally { setBusy(false); }
  };
  const canSteer = session.provider === 'codex' && !!activeTurnId && ['running', 'approval'].includes(session.status) && !session.stoppedAt;
  return <section className="session-input-queue" aria-label="待发送消息">
    <header><span>{queue.paused ? '已暂停' : '待发送'} · {items.length}</span><span className="queue-hint">{queue.paused ? '继续后按顺序发送' : '本轮结束后依次发送'}</span>
      <button className="queue-control" disabled={disabled || !!editing} title={queue.paused ? '继续队列' : '暂停队列'} aria-label={queue.paused ? '继续队列' : '暂停队列'} onClick={() => void action(queue.paused ? 'resume' : 'pause')}>{queue.paused ? <Play size={12}/> : <Pause size={12}/>}</button></header>
    <div className="queue-rows">{items.map((item, index) => <div className="queue-row" key={item.id} data-queue-id={item.id} draggable={!disabled && item.state === 'queued' && !editing} onDragStart={event => { setDragging(item.id); event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDragging('')} onDragOver={event => { if (dragging && !disabled && item.state === 'queued') event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (dragging && !disabled && item.state === 'queued') void action('move', { itemId: dragging, beforeId: item.id }); setDragging(''); }} onContextMenu={event => { if ((event.target as HTMLElement).closest('input')) return; setMenu({ anchor: contextAnchor(event), id: item.id }); }}>
      <span className="queue-number">{item.state === 'sending' ? <LoaderCircle className="spin" size={12}/> : index + 1}</span>
      {editing === item.id ? <input className="queue-edit" autoFocus aria-label="编辑待发送消息" value={text} disabled={busy} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Escape') setEditing(''); if (e.key === 'Enter') { e.preventDefault(); void action('edit', { itemId: item.id, text }); } }}/>
        : <button className="queue-text" aria-label={`查看第 ${index + 1} 条待发送消息`} title={item.input.text + (item.input.sourceIds.length ? `\n附带 ${item.input.sourceIds.length} 份参考资料` : '') + (item.input.capabilities?.length ? '\n能力：' + item.input.capabilities.map(c => c.name).join('、') : '')} onClick={() => setPreview(item.id)}>{item.input.text.replace(/\s*\r?\n\s*/g, ' ')}</button>}
      <div className="queue-actions">{editing === item.id ? <>
        <button disabled={disabled || !text.trim()} aria-label="保存待发送消息" title="保存" onClick={() => void action('edit', { itemId: item.id, text })}><Check size={13}/></button>
        <button disabled={busy} aria-label="取消编辑" title="取消编辑" onClick={() => setEditing('')}><X size={13}/></button>
      </> : <>
        {session.provider === 'codex' && <button className="queue-steer" disabled={disabled || !canSteer || item.state !== 'queued'} title={canSteer ? '用于当前轮，并从队列中移除' : '当前轮就绪后可引导'} onClick={() => void action('steer', { itemId: item.id, expectedTurnId: activeTurnId })}><CornerUpLeft size={12}/>引导</button>}
        <button disabled={disabled || item.state !== 'queued'} aria-label={`编辑第 ${index + 1} 条待发送消息`} title="编辑（暂时暂停队列）" onClick={() => void beginEdit(item.id, item.input.text)}><Pencil size={12}/></button>
        <button disabled={disabled || item.state !== 'queued'} aria-label={`移除第 ${index + 1} 条待发送消息`} title="移除" onClick={() => void action('remove', { itemId: item.id })}><X size={13}/></button>
      </>}</div>
    </div>)}</div>
    {(error || queue.error) && <p className="queue-error" role="alert">{error || queue.error}</p>}
    {menu && items.some(item => item.id === menu.id) && <ContextMenu anchor={menu.anchor} label="待发送消息操作" close={() => setMenu(undefined)} actions={(() => {
      const index = items.findIndex(item => item.id === menu.id), item = items[index], unavailable = disabled || item.state !== 'queued';
      return [
        { label: '编辑消息', disabled: unavailable, run: () => beginEdit(item.id, item.input.text) },
        { label: '提前一条', disabled: unavailable || index === 0 || items[index - 1]?.state !== 'queued', run: () => action('move', { itemId: item.id, beforeId: items[index - 1].id }) },
        { label: '推后一条', disabled: unavailable || index === items.length - 1, run: () => action('move', { itemId: item.id, beforeId: items[index + 2]?.id }) },
        ...(session.provider === 'codex' ? [{ label: '引导当前任务', disabled: unavailable || !canSteer, run: () => action('steer', { itemId: item.id, expectedTurnId: activeTurnId }) }] : []),
        { label: '删除待发送消息', disabled: unavailable, separator: true, run: () => action('remove', { itemId: item.id }) },
      ];
    })()}/>}
    {preview && items.find(item => item.id === preview) && <QueuePreview text={items.find(item => item.id === preview)!.input.text} close={() => setPreview('')}/>}
  </section>;
}
