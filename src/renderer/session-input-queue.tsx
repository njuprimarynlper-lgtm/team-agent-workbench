import React, { useEffect, useRef, useState } from 'react';
import { CornerUpLeft, Pencil, X, Pause, Play, LoaderCircle } from 'lucide-react';
import type { AgentSession, FollowUpMode, SessionInput, WorkbenchAPI } from '../shared/types';
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

export async function queueDraftAction(api: WorkbenchAPI, sessionId: string, itemId: string, draft: SessionInput, action: 'beginEdit' | 'cancelEdit' | 'saveEdit', replace: (input: SessionInput) => void) {
  const input = await api.call<SessionInput>('session.queue.' + action, { id: sessionId, itemId, draft });
  replace({ capabilities: [], nextTurnOnly: false, editingQueueItemId: undefined, ...input });
}
export function SessionInputQueue({ session, activeTurnId, api, changed, locked, draft, replace, sideChat, followUpMode, lockDraft }: {
  session: AgentSession; activeTurnId?: string; api: WorkbenchAPI; changed: () => Promise<void>; locked?: boolean; draft?: SessionInput; replace?: (input: SessionInput) => void;
  lockDraft?: (locked: boolean) => boolean;
  sideChat?: (itemId: string) => Promise<void>; followUpMode?: FollowUpMode;
}) {
  const editing = session.inputQueue?.editing?.itemId;
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState(''), [dragging, setDragging] = useState('');
  const [menu, setMenu] = useState<{ anchor: ContextAnchor; id: string }>();
  const queueRef = useRef<HTMLElement>(null);
  const queue = session.inputQueue;
  const items = queue?.items.filter(item => !item.submitted && item.id !== editing) || [];
  const lastRemoval = queue?.removed?.at(-1);
  const [, refreshUndo] = useState(0);
  useEffect(() => {
    if (!lastRemoval?.removedAt) return;
    const remaining = lastRemoval.removedAt + 15000 - Date.now();
    const timer = setTimeout(() => refreshUndo(previous => previous + 1), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [lastRemoval?.item.id, lastRemoval?.removedAt]);
  const undo = !lastRemoval?.removedAt || lastRemoval.removedAt + 15000 > Date.now() ? lastRemoval : undefined;
  const recovery = session.historyEditRecovery && !['running', 'starting', 'approval'].includes(session.status);
  if ((!items.length && !editing && !undo && !recovery) || session.cursorNative) return null;
  const action = async (name: string, extra: object = {}) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await api.call('session.queue.' + name, { id: session.id, ...extra }); await changed(); }
    catch (reason: any) { setError(reason.message); }
    finally { setBusy(false); }
  };
  const disabled = busy || locked || !!session.closedAt;
  const editRow = async (itemId: string, cancel = false) => {
    if (!draft || !replace || disabled || lockDraft?.(true) === false) return;
    setBusy(true); setError('');
    try {
      await queueDraftAction(api, session.id, itemId, draft, cancel ? 'cancelEdit' : 'beginEdit', replace);
      await changed();
      queueRef.current?.parentElement?.querySelector<HTMLElement>('.composer textarea,.composer [contenteditable=true]')?.focus();
    } catch (reason: any) { setError(reason.message); }
    finally { lockDraft?.(false); setBusy(false); }
  };
  const resolveHistoryEdit = async (restore: boolean) => {
    if (busy || !replace) return;
    if (restore && (draft?.text.trim() || draft?.sourceIds.length || draft?.capabilities?.length || draft?.editingQueueItemId)) { setError('请先处理输入框中已有的草稿'); return; }
    if (lockDraft?.(true) === false) return;
    setBusy(true); setError('');
    try {
      const input = await api.call<SessionInput>('session.editRecovery', { id: session.id, restore });
      if (restore) replace(input);
      await changed();
    } catch (reason: any) { setError(reason.message); }
    finally { lockDraft?.(false); setBusy(false); }
  };
  const canSteer = session.provider === 'codex' && !session.contextCompacting && !!activeTurnId && ['running', 'approval'].includes(session.status) && !session.stoppedAt;
  return <section ref={queueRef} className="session-input-queue" aria-label="待发送消息">
    {recovery && <header><span className="queue-hint">上次编辑未确认完成，请先核对对话。</span><button disabled={disabled} onClick={() => void resolveHistoryEdit(true)}>恢复编辑稿</button><button disabled={disabled} onClick={() => void resolveHistoryEdit(false)}>忽略</button></header>}
    {editing && <header><span className="queue-hint">正在编辑排队消息</span><button disabled={disabled} onClick={() => void editRow(editing, true)}>取消编辑</button></header>}
    {undo && <header><span className="queue-hint">已移除排队消息</span><button disabled={disabled} onClick={() => void action('undo', { itemId: undo.item.id })}>撤销删除</button></header>}
    {!!items.length && <header><span>{queue?.paused ? '已暂停' : items.some(row => row.failure || row.steerTurnId) ? '跟进消息' : '待发送'} · {items.length}</span><span className="queue-hint">{items.every(row => row.steerTurnId || row.failure?.uncertain) ? '' : queue?.paused ? '继续后按顺序发送' : session.contextCompacting ? '压缩完成后依次发送' : '本轮结束后依次发送'}</span>
      <button className="queue-control" disabled={disabled} title={queue?.paused ? '继续队列' : '暂停队列'} aria-label={queue?.paused ? '继续队列' : '暂停队列'} onClick={() => void action(queue?.paused ? 'resume' : 'pause')}>{queue?.paused ? <Play size={12}/> : <Pause size={12}/>}</button></header>}
    <div className="queue-rows">{items.map((item, index) => <div className="queue-row" key={item.id} data-queue-id={item.id} draggable={!disabled && item.state === 'queued'} onDragStart={event => { setDragging(item.id); event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDragging('')} onDragOver={event => { if (dragging && !disabled && item.state === 'queued') event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (dragging && !disabled && item.state === 'queued') void action('move', { itemId: dragging, beforeId: item.id }); setDragging(''); }} onContextMenu={event => { if ((event.target as HTMLElement).closest('input,textarea,.markdown-editor')) return; setMenu({ anchor: contextAnchor(event), id: item.id }); }}>
      <span className="queue-number">{item.state === 'sending' ? <LoaderCircle className="spin" size={12}/> : index + 1}</span>
      <button className="queue-text" aria-label={`查看第 ${index + 1} 条待发送消息`} title={item.failure?.message || item.input.text} onClick={() => setPreview(item.id)}>{item.input.text}{item.failure && <small> · {item.failure.uncertain ? '送达待确认' : '未送达'}</small>}</button>
      <div className="queue-actions">
        {item.failure && !item.steerTurnId && !item.failure.uncertain && <button disabled={disabled || item.state !== 'queued' || !['idle','error'].includes(session.status)} onClick={() => void action('retry', { itemId: item.id })}>重试发送</button>}
        {item.steerTurnId && !item.failure ? <span className="queue-hint">正在引导…</span> : session.provider === 'codex' && !session.contextCompacting && !item.input.nextTurnOnly && !item.failure?.uncertain && (!item.failure || item.steerTurnId) ?
          (item.steerTurnId && item.steerTurnId !== activeTurnId
            ? <button disabled={disabled || item.state !== 'queued'} onClick={() => void action('requeue', { itemId: item.id })}>改为排队</button>
            : <button className="queue-steer" disabled={disabled || !canSteer || item.state !== 'queued'} onClick={() => void action('steer', { itemId: item.id, expectedTurnId: activeTurnId })}><CornerUpLeft size={12}/>{item.steerTurnId ? '重试引导' : '引导'}</button>) : null}
        {session.contextCompacting && <span className="queue-hint">已排队</span>}
        <button disabled={disabled || !!editing || !!item.failure?.uncertain || item.state !== 'queued'} aria-label={`编辑第 ${index + 1} 条待发送消息`} onClick={() => void editRow(item.id)}><Pencil size={12}/></button>
        <button disabled={disabled || item.state !== 'queued'} aria-label={`移除第 ${index + 1} 条待发送消息`} title="移除" onClick={() => void action('remove', { itemId: item.id })}><X size={13}/></button>
        <button disabled={disabled || item.state !== 'queued'} aria-label="待发送消息操作" onClick={e => setMenu({ anchor: contextAnchor(e), id: item.id })}>⋯</button>
      </div>
    </div>)}</div>
    {(error || queue?.error) && <p className="queue-error" role="alert">{error || queue?.error}</p>}
    {menu && items.some(item => item.id === menu.id) && <ContextMenu anchor={menu.anchor} label="待发送消息操作" close={() => setMenu(undefined)} actions={(() => {
      const index = items.findIndex(item => item.id === menu.id), item = items[index], unavailable = disabled || item.state !== 'queued';
      return [
        { label: '编辑消息', disabled: unavailable || !!editing || !!item.failure?.uncertain, run: () => editRow(item.id) },
        { label: '提前一条', disabled: unavailable || index === 0 || items[index - 1]?.state !== 'queued', run: () => action('move', { itemId: item.id, beforeId: items[index - 1].id }) },
        { label: '推后一条', disabled: unavailable || index === items.length - 1, run: () => action('move', { itemId: item.id, beforeId: items[index + 2]?.id }) },
        ...(session.provider === 'codex' && !session.contextCompacting && !item.input.nextTurnOnly && !item.steerTurnId && !item.failure ? [{ label: '引导当前任务', disabled: unavailable || !canSteer, run: () => action('steer', { itemId: item.id, expectedTurnId: activeTurnId }) }] : []),
        ...(item.steerTurnId && !item.failure?.uncertain ? [{ label: '改为下一轮排队', disabled: unavailable, run: () => action('requeue', { itemId: item.id }) }] : []),
        ...(sideChat && !item.failure?.uncertain ? [{ label: '在侧边聊天中打开', disabled: unavailable, run: () => sideChat(item.id).catch(reason => setError(reason.message)) }] : []),
        ...(session.provider === 'codex' ? [{ label: followUpMode === 'steer' ? '启用排队模式' : '关闭排队模式', run: async () => { try { await api.call('settings.agent.save', { followUpMode: followUpMode === 'steer' ? 'queue' : 'steer' }); await changed(); } catch (e: any) { setError(e.message); } } }] : []),
        { label: '删除待发送消息', disabled: unavailable, separator: true, run: () => action('remove', { itemId: item.id }) },
      ];
    })()}/>}
    {preview && items.find(item => item.id === preview) && <QueuePreview text={items.find(item => item.id === preview)!.input.text} close={() => setPreview('')}/>}
  </section>;
}
