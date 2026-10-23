import React, { useState } from 'react';
import { CornerUpLeft, Pencil, X, Check, Pause, Play, LoaderCircle } from 'lucide-react';
import type { AgentSession, WorkbenchAPI } from '../shared/types';

export function SessionInputQueue({ session, activeTurnId, api, changed, locked }: {
  session: AgentSession; activeTurnId?: string; api: WorkbenchAPI; changed: () => Promise<void>; locked?: boolean;
}) {
  const [editing, setEditing] = useState(''), [text, setText] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
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
    <div className="queue-rows">{items.map((item, index) => <div className="queue-row" key={item.id} data-queue-id={item.id}>
      <span className="queue-number">{item.state === 'sending' ? <LoaderCircle className="spin" size={12}/> : index + 1}</span>
      {editing === item.id ? <input className="queue-edit" autoFocus aria-label="编辑待发送消息" value={text} disabled={busy} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Escape') setEditing(''); if (e.key === 'Enter') { e.preventDefault(); void action('edit', { itemId: item.id, text }); } }}/>
        : <span className="queue-text" title={item.input.text + (item.input.sourceIds.length ? `\n附带 ${item.input.sourceIds.length} 份参考资料` : '') + (item.input.capabilities?.length ? '\n能力：' + item.input.capabilities.map(c => c.name).join('、') : '')}>{item.input.text.replace(/\s*\r?\n\s*/g, ' ')}</span>}
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
  </section>;
}
