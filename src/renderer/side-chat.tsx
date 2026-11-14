import { MarkdownEditor } from './markdown-editor';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FollowUpMode, SessionInput, SideChat, SourceFile, WorkbenchAPI } from '../shared/types';
import { ComposerCapabilities } from './composer-capabilities';
import { CapabilityChips } from './capability-chips';
import { ComposerSettings } from './composer-settings';
import { ComposerMode } from './composer-mode';
import { ComposerReferenceTabs } from './composer-reference-tabs';
import { ConversationMessage } from './conversation-message';
import type { TranscriptPage } from '../shared/transcript-page';
import { SessionTranscript } from './session-transcript';
import { SessionTurnProgress } from './turn-timing';
import { RequestCard } from './request-card';
import { ComposerActions, followUpAction } from './composer-actions';
import { SessionInputQueue, queueDraftAction } from './session-input-queue';
import { useConversationScroll } from './conversation-scroll';
import { PendingSessionMessage, type PendingMessage } from './pending-session-message';
import { sessionMessageCount } from '../shared/transcript-page';

export function SideChatPanel({ chats, selectedId, select, onEmpty, api, changed, creating, active = true, openSettings, activeTurns, followUpMode }: {
  chats: SideChat[]; selectedId: string; select: (id: string) => void; onEmpty?: () => void; api: WorkbenchAPI; changed: () => Promise<void>; creating?: boolean; active?: boolean; openSettings?: (parentId: string) => void; activeTurns?: Record<string, string>; followUpMode?: FollowUpMode;
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
    {chat ? <SideChatConversation key={chat.id} chat={chat} api={api} changed={changed} active={active} closed={closed} openSettings={openSettings ? () => openSettings(chat.parentId) : undefined} activeTurnId={activeTurns?.[chat.session.id]} followUpMode={followUpMode}/> : !creating && <p className="subsession-empty">在 Codex 对话中选中文字，点击“侧边提问”。</p>}
  </section>;
}

function SideChatConversation({ chat, api, changed, active, closed, openSettings, activeTurnId, followUpMode }: { chat: SideChat; api: WorkbenchAPI; changed: () => Promise<void>; active: boolean; closed: () => void; openSettings?: () => void; activeTurnId?: string; followUpMode?: FollowUpMode }) {
  const [text, setText] = useState(chat.input?.text ?? chat.draft), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmClose, setConfirmClose] = useState(false), [closing, setClosing] = useState(false);
  const lock = useRef(false), closeLock = useRef(false), currentText = useRef(text), draftRevision = useRef(0);
  const [references, setReferences] = useState<Omit<SessionInput, 'text'>>(() => { const { text: _, ...input } = chat.input || { text: chat.draft, ...chat.pendingReferences, sourceIds: chat.pendingReferences?.sourceIds || [], answers: {} }; return input; });
  const currentReferences = useRef(references); currentReferences.current = references;
  const [pending, setPending] = useState<PendingMessage>(), [failed, setFailed] = useState<SessionInput>();
  currentText.current = text;
  const session = chat.session, running = ['starting', 'running', 'approval'].includes(session.status);
  const hasConversation = !!(sessionMessageCount(session) || text.trim() || references.sourceIds.length || references.capabilities?.length || pending || running || session.approvals.length);
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
    count: (chat.inheritedMessageCount || 0) + sessionMessageCount(session) - session.messages.length,
    parentCount: chat.inheritedMessageCount || 0,
    read: (before: number, limit: number) => api.call<TranscriptPage>('sidechat.transcriptPage', { id: chat.id, parentId: chat.parentId, before, limit }),
  }), [api, chat.id, chat.parentId, chat.inheritedMessageCount, session.messageCount, session.messages.length]);
  const scrolling = useConversationScroll(chat.id, `${sessionMessageCount(session)}:${session.messages.at(-1)?.text}:${pending?.text}`, active);
  const renderMessage = useMemo(() => (message: typeof session.messages[number]) => <ConversationMessage key={message.id} message={message} provider={session.provider} sessionId={session.id} text={message.userText ?? message.text}/>, [session.id, session.provider]);
  const edit = (value: string, selected = currentReferences.current) => { draftRevision.current++; currentText.current = value; currentReferences.current = selected; setText(value); setReferences(selected); const revision = draftRevision.current; void api.call('session.input', { id: session.id, input: { ...selected, text: value } }).catch(reason => { if (draftRevision.current === revision) setError(reason.message); }); };
  const replace = (input: SessionInput) => { const { text, ...selected } = input; edit(text, selected); };
  const lockDraft = (value: boolean) => { if (value && lock.current) return false; lock.current = value; setBusy(value); return true; };
  const finishQueueEdit = async (cancel: boolean) => {
    const input = { text: currentText.current, ...currentReferences.current };
    if (!input.editingQueueItemId || !lockDraft(true)) return;
    try { await queueDraftAction(api, session.id, input.editingQueueItemId, input, cancel ? 'cancelEdit' : 'saveEdit', replace); await changed(); }
    catch (reason: any) { setError(reason.message); }
    finally { lockDraft(false); }
  };
  const send = async (invert = false) => {
    if (lock.current || chat.expired || !currentText.current.trim()) return;
    if (currentReferences.current.editingQueueItemId) return finishQueueEdit(false);
    const sent: SessionInput = { text: currentText.current, ...structuredClone(currentReferences.current), answers: {} }; lock.current = true; setBusy(true);
    const mode = followUpAction(session, activeTurnId, sent, followUpMode, invert);
    setPending({ text: sent.text, beforeMessageCount: sessionMessageCount(session), phase: mode === 'steer' ? 'steering' : mode === 'queue' ? 'queueing' : 'submitting' });
    edit('', { sourceIds: [], capabilities: [], answers: {} }); const revision = draftRevision.current; scrolling.latest();
    try {
      setError(''); const accepted = mode === 'queue' || mode === 'steer' ? await api.call('session.enqueue', { id: session.id, ...sent, expectedTurnId: mode === 'steer' ? activeTurnId : undefined }) : await invoke('sidechat.send', { text: sent.text, references: { sourceIds: sent.sourceIds, capabilities: sent.capabilities } });
      if (accepted === false) throw new Error('消息未能送达，请检查后重试');
      setFailed(undefined);
      await changed().catch(reason => setError('消息已发送，刷新失败：' + reason.message));
    } catch (reason: any) { setError(reason.message); setFailed(sent); if (draftRevision.current === revision) replace(sent); }
    finally { lock.current = false; setBusy(false); setPending(undefined); }
  };
  return <div className="subsession-chat side-chat-conversation">
    <header><div className="subsession-heading"><b>侧边提问</b><button className="text-button" disabled={closing} title="结束并清除这条临时对话" onClick={requestClose}>{closing ? '正在结束…' : '结束侧聊'}</button></div>
      <p className="side-chat-parent" title={chat.parentTitle}>来自：{chat.parentTitle}</p><p className="subsession-context-note">临时对话 · 结束后清除</p>
    </header>
    {confirmClose && createPortal(<div className="modal-backdrop" onPointerDown={event => { if (event.target === event.currentTarget && !closing) setConfirmClose(false); }}><section className="modal" role="alertdialog" aria-modal="true" aria-labelledby="side-chat-close-title" aria-describedby="side-chat-close-description"><header><h2 id="side-chat-close-title">结束这条侧聊？</h2></header><div className="modal-body"><p id="side-chat-close-description">这段临时对话会被清除，无法恢复。主会话不受影响。</p>{running && <p>当前回答将停止。</p>}{!!text.trim() && <p>未发送的输入也会丢失。</p>}{error && <p className="inline-error" role="alert">{error}</p>}</div><footer><button className="secondary" autoFocus disabled={closing} onClick={() => setConfirmClose(false)}>取消</button><button className="primary" disabled={closing} onClick={() => void close()}>{closing ? '正在结束…' : '结束并清除'}</button></footer></section></div>, document.body)}
    <div className="subsession-messages" data-transcript-scroll tabIndex={0} ref={scrolling.ref} onScroll={scrolling.onScroll}>
      {!sessionMessageCount(session) && <p className="muted small">已继承创建时的上下文，可以直接提问。</p>}
      <SessionTranscript key={session.id} session={session} renderMessage={renderMessage} active={active} inherited={parentHistory} readingEarlier={scrolling.readingEarlier}/>
      {pending && <PendingSessionMessage pending={pending} messages={session.messages} session={session}/>}
      <SessionTurnProgress session={session}/>
      {!chat.expired && session.approvals.map(request => <RequestCard key={request.id} request={request} onAnswer={(option, answers) => void action(() => invoke('sidechat.answer', { requestId: request.id, option, answers }))}/>)}
      {scrolling.away && <button className="scroll-latest" onClick={scrolling.latest}>↓ 回到最新消息</button>}
      {failed && <button className="text-button" onClick={() => { const latest = { text: currentText.current, ...currentReferences.current, answers: {} }; if ((latest.text.trim() || latest.sourceIds.length || latest.capabilities?.length) && JSON.stringify(latest) !== JSON.stringify(failed)) { setError('输入框中有新的草稿，请先保存草稿后再恢复上一条消息。'); return; } replace(failed); setFailed(undefined); setError(''); }}>恢复未发送消息到输入框</button>}
      {(error || session.error || chat.expired) && <p className="inline-error" role="alert">{error || (chat.expired ? '原连接已关闭，此侧聊已失效。已有内容仍可查看，请从原会话重新创建侧聊。' : session.error)}</p>}
    </div>
    <div className="subsession-composer">
      <SessionInputQueue session={session} activeTurnId={activeTurnId} api={api} changed={changed} locked={chat.expired || busy} draft={{ text, ...references }} replace={replace} lockDraft={lockDraft} followUpMode={followUpMode}/>
      <CapabilityChips selected={references.capabilities || []} disabled={chat.expired} change={capabilities => edit(currentText.current, { ...currentReferences.current, capabilities })}/>
      <div className="session-sync-frame"><div className="session-composer-tabs"><span className="side-chat-context-tab">临时对话</span><ComposerReferenceTabs session={session} api={api} locked={!!chat.expired || busy} removalLocked={busy || !!chat.expired || session.status === 'starting'} syncOpen={false} onOpen={() => {}} controls={{ sourceIds: references.sourceIds, select: sourceIds => edit(currentText.current, { ...currentReferences.current, sourceIds }), detach: async source => {
        const result = await api.call<{ sourceIds: string[] }>('session.detachPendingSource', { id: session.id, sourceId: source.id });
        edit(currentText.current, { ...currentReferences.current, sourceIds: currentReferences.current.sourceIds.filter(id => !result.sourceIds.includes(id)) }); await changed();
      } }}/></div><div className="composer"><MarkdownEditor aria-label="侧边提问输入" disabled={chat.expired} value={text} maxLength={128 * 1024} placeholder="针对当前上下文提问…" onChange={event => edit(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && references.editingQueueItemId && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); void finishQueueEdit(true); return; } if (event.key === 'ArrowUp' && !text && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing) { const previous = session.messages.findLast(message => message.role === 'user'); if (previous) { event.preventDefault(); edit(previous.userText ?? previous.text); } return; } if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!event.repeat) void send(event.ctrlKey || event.metaKey); } }}/><div className="composer-bottom">
        <fieldset className="side-chat-composer-tools" disabled={chat.expired}><ComposerCapabilities session={session} selected={references.capabilities || []} change={capabilities => edit(currentText.current, { ...currentReferences.current, capabilities })} text={text} changeText={value => edit(value)} changed={changed} openSettings={openSettings} attach={session.codexRemote ? undefined : () => void action(async () => {
          const files = await api.call<SourceFile[]>('session.attachLocal', { id: session.id });
          edit(currentText.current, { ...currentReferences.current, sourceIds: [...new Set([...currentReferences.current.sourceIds, ...files.map(file => file.id)])] });
        })}/><ComposerMode session={session}/><ComposerSettings session={session} modelLocked/></fieldset>
        <div className="subsession-composer-actions"><ComposerActions session={session} activeTurnId={activeTurnId} text={text} busy={busy} locked={chat.expired} followUpMode={followUpMode} nextTurnOnly={references.nextTurnOnly} send={() => void send()} stop={() => void action(() => invoke('sidechat.stop'))}/></div>
      </div></div></div>
    </div>
  </div>;
}
