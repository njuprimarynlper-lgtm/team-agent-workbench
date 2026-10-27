import { MarkdownEditor } from './markdown-editor';
import React, { useRef, useState } from 'react';
import type { SideChat, WorkbenchAPI } from '../shared/types';
import { ConversationMessage } from './conversation-message';
import { SessionTranscript } from './session-transcript';
import { RequestCard } from './request-card';
import { ArrowUp, LoaderCircle, Square } from 'lucide-react';
import { useConversationScroll } from './conversation-scroll';
import { PendingSessionMessage, type PendingMessage } from './pending-session-message';

export function SideChatPanel({ chats, selectedId, select, api, changed, creating }: {
  chats: SideChat[]; selectedId: string; select: (id: string) => void; api: WorkbenchAPI; changed: () => Promise<void>; creating?: boolean;
}) {
  const chat = chats.find(value => value.id === selectedId) || chats.at(-1);
  return <section className="side-chat-panel" aria-label="侧边提问">
    {!!chats.length && <nav className="side-chat-tabs" aria-label="临时侧聊列表">{chats.map((value, index) => <button key={value.id} aria-pressed={value.id === chat?.id} title={value.parentTitle} onClick={() => select(value.id)}>{['running', 'starting', 'approval'].includes(value.session.status) && <span className="status-pulse"/>}侧聊 {index + 1}{value.expired ? ' · 已失效' : ''}</button>)}</nav>}
    {creating && <p className="side-chat-notice" role="status"><span className="status-pulse"/>正在创建侧聊…</p>}
    {chat ? <SideChatConversation key={chat.id} chat={chat} api={api} changed={changed}/> : !creating && <p className="subsession-empty">在 Codex 对话中选中文字，点击“侧边提问”。</p>}
  </section>;
}

function SideChatConversation({ chat, api, changed }: { chat: SideChat; api: WorkbenchAPI; changed: () => Promise<void> }) {
  const [text, setText] = useState(chat.draft), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmClose, setConfirmClose] = useState(false);
  const lock = useRef(false), currentText = useRef(text), draftRevision = useRef(0);
  const [pending, setPending] = useState<PendingMessage>(), [failed, setFailed] = useState('');
  currentText.current = text;
  const session = chat.session, running = ['starting', 'running', 'approval'].includes(session.status);
  const invoke = <T,>(action: string, data = {}) => api.call<T>(action, { id: chat.id, parentId: chat.parentId, ...data });
  const action = async (job: () => Promise<unknown>) => { try { setError(''); await job(); await changed(); } catch (reason: any) { setError(reason.message); } };
  const scrolling = useConversationScroll(chat.id, `${session.messages.length}:${session.messages.at(-1)?.text}:${pending?.text}`);
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
    <header><div className="subsession-heading"><b>侧边提问</b><button className="text-button" onClick={() => setConfirmClose(true)}>关闭侧聊</button></div>
      <p className="side-chat-parent" title={chat.parentTitle}>来自：{chat.parentTitle}</p><p className="subsession-context-note">临时对话 · 关闭后不保留</p>
    </header>
    {confirmClose && <div className="side-chat-notice" role="alert">关闭后将清除此侧聊。<button className="text-button" onClick={() => setConfirmClose(false)}>保留</button><button className="text-button" onClick={() => void action(() => invoke('sidechat.close'))}>关闭并清除</button></div>}
    <div className="subsession-messages" ref={scrolling.ref} onScroll={scrolling.onScroll}>
      {!session.messages.length && <p className="muted small">已继承创建时的上下文，可以直接提问。</p>}
      <SessionTranscript session={session} renderMessage={message => <ConversationMessage key={message.id} message={message} provider={session.provider} text={message.text}/>}/>
      {pending && <PendingSessionMessage pending={pending} messages={session.messages} session={session}/>}
      {running && <p className="muted small" role="status"><span className="status-pulse"/>{session.status === 'approval' ? '等待你的处理' : '正在回复…'}</p>}
      {!chat.expired && session.approvals.map(request => <RequestCard key={request.id} request={request} onAnswer={(option, answers) => void action(() => invoke('sidechat.answer', { requestId: request.id, option, answers }))}/>)}
      {scrolling.away && <button className="scroll-latest" onClick={scrolling.latest}>↓ 回到最新消息</button>}
      {failed && <button className="text-button" onClick={() => { if (currentText.current.trim() && currentText.current !== failed) { setError('输入框中有新的草稿，请先保存草稿后再恢复上一条消息。'); return; } edit(failed); setFailed(''); setError(''); }}>恢复未发送消息到输入框</button>}
      {(error || session.error || chat.expired) && <p className="inline-error" role="alert">{error || (chat.expired ? '原连接已关闭，此侧聊已失效。已有内容仍可查看，请从原会话重新创建侧聊。' : session.error)}</p>}
    </div>
    <div className="subsession-composer"><div className="composer"><MarkdownEditor aria-label="侧边提问输入" disabled={chat.expired} value={text} maxLength={128 * 1024} placeholder="针对当前上下文提问…" onChange={event => edit(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!event.repeat) void send(); } }}/><div className="composer-bottom"><span className="muted small">临时对话</span><div className="spacer"/>{running && !chat.expired && <button className="send stop" aria-label="停止侧聊" title="停止" onClick={() => void action(() => invoke('sidechat.stop'))}><Square size={15}/></button>}<button className="send" aria-label={busy ? '正在发送侧聊' : '发送侧聊'} title="发送" disabled={busy || running || chat.expired || !text.trim()} onClick={() => void send()}>{busy ? <LoaderCircle size={17} className="spin"/> : <ArrowUp size={19}/>}</button></div></div></div>
  </div>;
}
