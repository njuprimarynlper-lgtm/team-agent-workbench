import { MarkdownEditor } from './markdown-editor';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SideChat, WorkbenchAPI } from '../shared/types';
import { ConversationMessage } from './conversation-message';
import type { TranscriptPage } from '../shared/transcript-page';
import { SessionTranscript } from './session-transcript';
import { SessionTurnProgress } from './turn-timing';
import { RequestCard } from './request-card';
import { ArrowUp, LoaderCircle, Square } from 'lucide-react';
import { useConversationScroll } from './conversation-scroll';
import { PendingSessionMessage, type PendingMessage } from './pending-session-message';

export function SideChatPanel({ chats, selectedId, select, onEmpty, api, changed, creating, active = true }: {
  chats: SideChat[]; selectedId: string; select: (id: string) => void; onEmpty?: () => void; api: WorkbenchAPI; changed: () => Promise<void>; creating?: boolean; active?: boolean;
}) {
  const chat = chats.find(value => value.id === selectedId) || chats.at(-1);
  const closed = () => {
    const index = chats.findIndex(value => value.id === chat?.id);
    const nextId = chats[index + 1]?.id || chats[index - 1]?.id || '';
    select(nextId);
    if (!nextId && !creating) onEmpty?.();
  };
  return <section className="side-chat-panel" aria-label="侧边提问">
    {!!chats.length && <nav className="side-chat-tabs" aria-label="临时侧聊列表">{chats.map((value, index) => <button key={value.id} aria-pressed={value.id === chat?.id} title={value.parentTitle} onClick={() => select(value.id)}>{['running', 'starting', 'approval'].includes(value.session.status) && <span className="status-pulse"/>}侧聊 {index + 1}{value.expired ? ' · 已失效' : ''}</button>)}</nav>}
    {creating && <p className="side-chat-notice" role="status"><span className="status-pulse"/>正在创建侧聊…</p>}
    {chat ? <SideChatConversation key={chat.id} chat={chat} api={api} changed={changed} active={active} closed={closed}/> : !creating && <p className="subsession-empty">在 Codex 对话中选中文字，点击“侧边提问”。</p>}
  </section>;
}

function SideChatConversation({ chat, api, changed, active, closed }: { chat: SideChat; api: WorkbenchAPI; changed: () => Promise<void>; active: boolean; closed: () => void }) {
  const [text, setText] = useState(chat.draft), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmClose, setConfirmClose] = useState(false), [closing, setClosing] = useState(false);
  const lock = useRef(false), closeLock = useRef(false), currentText = useRef(text), draftRevision = useRef(0);
  const [pending, setPending] = useState<PendingMessage>(), [failed, setFailed] = useState('');
  currentText.current = text;
  const session = chat.session, running = ['starting', 'running', 'approval'].includes(session.status);
  const hasConversation = !!(session.messages.length || text.trim() || pending || running || session.approvals.length);
  const invoke = <T,>(action: string, data = {}) => api.call<T>(action, { id: chat.id, parentId: chat.parentId, ...data });
  const action = async (job: () => Promise<unknown>) => { try { setError(''); await job(); await changed(); } catch (reason: any) { setError(reason.message); } };
  useEffect(() => {
    if (!confirmClose) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !closeLock.current) setConfirmClose(false); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [confirmClose]);
  const close = async () => {
    if (closeLock.current) return;
    closeLock.current = true; setClosing(true); setError('');
    try {
      await invoke('sidechat.close');
      setConfirmClose(false);
      closed();
      await changed();
    } catch (reason: any) {
      setError(reason.message);
      closeLock.current = false; setClosing(false);
    }
  };
  const requestClose = () => { if (hasConversation) setConfirmClose(true); else void close(); };
  const parentHistory = useMemo(() => ({
    count: chat.inheritedMessageCount || 0,
    read: (before: number, limit: number) => api.call<TranscriptPage>('sidechat.historyPage', { id: chat.id, parentId: chat.parentId, before, limit }),
  }), [api, chat.id, chat.parentId, chat.inheritedMessageCount]);
  const scrolling = useConversationScroll(chat.id, `${session.messages.length}:${session.messages.at(-1)?.text}:${pending?.text}`, active);
  const renderMessage = useMemo(() => (message: typeof session.messages[number]) => <ConversationMessage key={message.id} message={message} provider={session.provider} text={message.userText ?? message.text}/>, [session.provider]);
  const edit = (value: string) => { draftRevision.current++; currentText.current = value; setText(value); void invoke('sidechat.draft', { text: value }).catch(reason => setError(reason.message)); };
  const send = async () => {
    if (lock.current || running || chat.expired || !text.trim()) return;
    const sent = text; lock.current = true; setBusy(true);
    setPending({ text: sent, beforeMessageCount: session.messages.length, phase: 'submitting' });
    edit(''); const revision = draftRevision.current; scrolling.latest();
    try {
      setError(''); const accepted = await invoke('sidechat.send', { text: sent });
      if (accepted === false) throw new Error('消息未能送达，请检查后重试');
      setFailed('');
      await changed().catch(reason => setError('消息已发送，刷新失败：' + reason.message));
    } catch (reason: any) { setError(reason.message); setFailed(sent); if (draftRevision.current === revision) edit(sent); }
    finally { lock.current = false; setBusy(false); setPending(undefined); }
  };
  return <div className="subsession-chat side-chat-conversation">
    <header><div className="subsession-heading"><b>侧边提问</b><button className="text-button" disabled={closing} title="结束并清除这条临时对话" onClick={requestClose}>{closing ? '正在结束…' : '结束侧聊'}</button></div>
      <p className="side-chat-parent" title={chat.parentTitle}>来自：{chat.parentTitle}</p><p className="subsession-context-note">临时对话 · 结束后清除</p>
    </header>
    {confirmClose && createPortal(<div className="modal-backdrop" onPointerDown={event => { if (event.target === event.currentTarget && !closing) setConfirmClose(false); }}><section className="modal" role="alertdialog" aria-modal="true" aria-labelledby="side-chat-close-title" aria-describedby="side-chat-close-description"><header><h2 id="side-chat-close-title">结束这条侧聊？</h2></header><div className="modal-body"><p id="side-chat-close-description">这段临时对话会被清除，无法恢复。主会话不受影响。</p>{running && <p>当前回答将停止。</p>}{!!text.trim() && <p>未发送的输入也会丢失。</p>}{error && <p className="inline-error" role="alert">{error}</p>}</div><footer><button className="secondary" autoFocus disabled={closing} onClick={() => setConfirmClose(false)}>取消</button><button className="primary" disabled={closing} onClick={() => void close()}>{closing ? '正在结束…' : '结束并清除'}</button></footer></section></div>, document.body)}
    <div className="subsession-messages" data-transcript-scroll tabIndex={0} ref={scrolling.ref} onScroll={scrolling.onScroll}>
      {!session.messages.length && <p className="muted small">已继承创建时的上下文，可以直接提问。</p>}
      <SessionTranscript key={session.id} session={session} renderMessage={renderMessage} active={active} inherited={parentHistory} readingEarlier={scrolling.readingEarlier}/>
      {pending && <PendingSessionMessage pending={pending} messages={session.messages} session={session}/>}
      <SessionTurnProgress session={session}/>
      {!chat.expired && session.approvals.map(request => <RequestCard key={request.id} request={request} onAnswer={(option, answers) => void action(() => invoke('sidechat.answer', { requestId: request.id, option, answers }))}/>)}
      {scrolling.away && <button className="scroll-latest" onClick={scrolling.latest}>↓ 回到最新消息</button>}
      {failed && <button className="text-button" onClick={() => { if (currentText.current.trim() && currentText.current !== failed) { setError('输入框中有新的草稿，请先保存草稿后再恢复上一条消息。'); return; } edit(failed); setFailed(''); setError(''); }}>恢复未发送消息到输入框</button>}
      {(error || session.error || chat.expired) && <p className="inline-error" role="alert">{error || (chat.expired ? '原连接已关闭，此侧聊已失效。已有内容仍可查看，请从原会话重新创建侧聊。' : session.error)}</p>}
    </div>
    <div className="subsession-composer">{chat.pendingReferences && (chat.pendingReferences.sourceIds.length > 0 || !!chat.pendingReferences.capabilities?.length) && <small className="muted">随本条发送 · {chat.pendingReferences.sourceIds.length} 个参考文件{chat.pendingReferences.capabilities?.map(cap => ' · ' + cap.name)}</small>}<div className="composer"><MarkdownEditor aria-label="侧边提问输入" disabled={chat.expired} value={text} maxLength={128 * 1024} placeholder="针对当前上下文提问…" onChange={event => edit(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!event.repeat) void send(); } }}/><div className="composer-bottom"><span className="muted small">临时对话</span><div className="spacer"/>{running && !chat.expired && <button className="send stop" aria-label="停止侧聊" title="停止" onClick={() => void action(() => invoke('sidechat.stop'))}><Square size={15}/></button>}<button className="send" aria-label={busy ? '正在发送侧聊' : '发送侧聊'} title="发送" disabled={busy || running || chat.expired || !text.trim()} onClick={() => void send()}>{busy ? <LoaderCircle size={17} className="spin"/> : <ArrowUp size={19}/>}</button></div></div></div>
  </div>;
}
