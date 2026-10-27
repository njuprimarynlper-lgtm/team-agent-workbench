import { SessionDirectoryStatus } from './project-directory';
import { DirectoryMoveNotice } from './directory-move-notice';
import React, { useEffect, useRef, useState } from 'react';
import { ConversationMessage } from './conversation-message';
import type { AgentSession, Message, SessionInput, WorkbenchAPI } from '../shared/types';
import { quoteSessionText, subsessionParentId } from '../shared/subsessions';
import { sessionMessageText } from '../shared/session-context-text';
import { submitOptimisticInput } from './composer-input';
import { SessionTranscript } from './session-transcript';
import { SelectionActions } from './selection-actions';
import { RequestCard } from './request-card';
import { SessionStatusIndicator, useSessionCompletionRead } from './session-status';
import { SessionMoreMenu } from './session-more-menu';
import { SessionName } from './session-name';
import { SessionSyncFrame } from './session-sync-frame';
import { SessionInputQueue } from './session-input-queue';
import { ComposerActions } from './composer-actions';
import { ComposerSettings } from './composer-settings';
import { ComposerMode } from './composer-mode';
import { PendingSessionMessage, PendingQueueMessage, type PendingMessage } from './pending-session-message';
import { ContextMenu, contextAnchor, type ContextAnchor } from './context-menu';
import { useConversationScroll } from './conversation-scroll';

export function SessionTree({ sessions, selectedId, childId, open, create, promote, organize, rename, manage, closeSession }: {
  sessions: AgentSession[]; selectedId: string; childId?: string;
  open: (session: AgentSession) => void; create: (session: AgentSession) => void;
  promote: (session: AgentSession) => void; organize?: (session: AgentSession) => React.ReactNode;
  rename: (id: string, title: string) => Promise<void>;
  manage?: (session: AgentSession) => void; closeSession?: (session: AgentSession) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [context, setContext] = useState<{ id: string; anchor: ContextAnchor; rename: () => void }>();
  const contextSession = sessions.find(item => item.id === context?.id);
  const selectedAncestors = new Set<string>();
  let selected = sessions.find(value => value.id === childId);
  while (selected && subsessionParentId(selected) && !selectedAncestors.has(subsessionParentId(selected)!)) {
    selectedAncestors.add(subsessionParentId(selected)!);
    selected = sessions.find(value => value.id === subsessionParentId(selected!));
  }
  useEffect(() => {
    setExpanded(value => ({ ...value, ...Object.fromEntries([...selectedAncestors].map(id => [id, true])) }));
  }, [childId]);
  const row = (session: AgentSession, ancestors: Set<string>): React.ReactNode => {
    if (ancestors.has(session.id)) return null;
    const path = new Set([...ancestors, session.id]);
    const children = sessions.filter(value => subsessionParentId(value) === session.id);
    const isExpanded = expanded[session.id] ?? selectedAncestors.has(session.id);
    return <div className="session-tree-node" key={session.id}>
      <div className="personal-session-row">
        <button className="icon" aria-label={`展开会话菜单：${session.title}`} aria-expanded={isExpanded} onClick={() => setExpanded(value => ({ ...value, [session.id]: !isExpanded }))}>{isExpanded ? '▾' : '▸'}</button>
        <SessionName title={session.title} variant="sidebar" save={title => rename(session.id, title)}>{begin => <button className={'session-row ' + ([selectedId, childId].includes(session.id) ? 'selected' : '')} data-session-id={session.id} title={session.title + ' · 双击修改名称'} onClick={() => open(session)} onDoubleClick={begin} onContextMenu={event => setContext({ id: session.id, anchor: contextAnchor(event), rename: begin })}><span className={'provider-icon ' + session.provider}>{session.provider === 'codex' ? 'G' : session.provider === 'cursor' ? 'C' : 'A'}</span><span><b>{session.title}</b><small>{session.closedAt ? '已关闭' : subsessionParentId(session) ? '子会话' : session.provider}</small></span><SessionStatusIndicator session={session}/></button>}</SessionName>
        {organize?.(session)}
      </div>
      {isExpanded && <div className="session-tree-children">
        {!session.closedAt && session.provider === 'codex' && <button className="text-button" onClick={() => create(session)}>＋ 创建子会话</button>}
        {subsessionParentId(session) && <button className="text-button" onClick={() => promote(session)}>升级为独立会话</button>}
        {children.map(value => row(value, path))}
      </div>}
    </div>;
  };
  return <>{sessions.filter(value => !subsessionParentId(value) || !sessions.some(parent => parent.id === subsessionParentId(value))).map(value => row(value, new Set()))}{context && contextSession && <ContextMenu anchor={context.anchor} label="会话操作" close={() => setContext(undefined)} actions={[
    { label: '重命名', run: context.rename },
    ...(manage ? [{ label: '移动到项目或分组', run: () => manage(contextSession) }] : []),
    ...(contextSession.provider === 'codex' && !contextSession.closedAt ? [{ label: '创建子会话', run: () => create(contextSession), separator: true }] : []),
    ...(subsessionParentId(contextSession) ? [{ label: '升级为独立会话', run: () => promote(contextSession) }] : []),
    ...(closeSession && !contextSession.closedAt ? [{ label: '关闭会话', run: () => closeSession(contextSession), separator: true }] : []),
  ]}/>}</>;
}

export function SubsessionChat({ session, sessions, input, edit, api, active, open, sideChat, promote, remove, closed, locked, changed, activeTurnId }: {
  session?: AgentSession; sessions: AgentSession[]; input?: SessionInput; edit: (id: string, patch: Partial<SessionInput>) => void;
  api: WorkbenchAPI; active: boolean; activeTurnId?: string; open: (session: AgentSession) => void; sideChat?: (session: AgentSession, text?: string) => void;
  promote: (session: AgentSession) => void; remove: (session: AgentSession) => void; closed: (id: string) => void; locked?: boolean; changed: () => Promise<void>;
}) {
  const [error, setError] = useState(''), [sending, setSending] = useState(false), [history, setHistory] = useState<Message[]>();
  const [pending, setPending] = useState<PendingMessage>(), [failed, setFailed] = useState<SessionInput>();
  const lock = useRef(false), availabilityLock = useRef(false);
  const [changingAvailability, setChangingAvailability] = useState(false);
  const latestInput = useRef(input); latestInput.current = input;
  useEffect(() => { setError(''); setHistory(undefined); }, [session?.id]);
  useSessionCompletionRead(active ? session : undefined, (id, completionId) => api.call('session.completion.read', { id, completionId }), reason => setError(reason.message));
  const scrolling = useConversationScroll(session?.id, `${session?.messages.length}:${session?.messages.at(-1)?.text}:${pending?.text}`, active), messages = scrolling.ref;
  if (!session) return <div className="subsession-empty">在左侧会话菜单中创建或打开子会话。</div>;
  const current = input || { text: '', sourceIds: [], answers: {} };
  const running = ['starting', 'running', 'approval'].includes(session.status);
  const parent = sessions.find(value => value.id === subsessionParentId(session));
  const children = sessions.filter(value => subsessionParentId(value) === session.id && !value.closedAt);
  const action = async (job: () => Promise<unknown>) => { try { setError(''); await job(); await changed(); } catch (reason: any) { setError(reason.message); } };
  const changeAvailability = async () => {
    if (availabilityLock.current) return;
    availabilityLock.current = true; setChangingAvailability(true); setError('');
    const wasClosed = !!session.closedAt;
    try {
      await api.call(wasClosed ? 'session.reopen' : 'session.close', { id: session.id });
      await changed();
      if (!wasClosed) closed(session.id);
    } catch (reason: any) { setError(reason.message); }
    finally { availabilityLock.current = false; setChangingAvailability(false); }
  };
  const send = async () => {
    if (lock.current || availabilityLock.current || session.closedAt || locked || !current.text.trim()) return;
    lock.current = true; setSending(true);
    const enqueue = running || !!session.inputQueue?.items.length;
    setPending({ text: current.text, beforeMessageCount: session.messages.length, phase: enqueue ? 'queueing' : 'submitting' });
    scrolling.latest();
    try { setError(''); const accepted = await submitOptimisticInput(api, session.id, current, () => latestInput.current || current, input => { latestInput.current = input; edit(session.id, input); }, enqueue); if (!accepted) throw new Error('消息未能送达，请检查后重试'); setFailed(undefined); await changed().catch(reason => setError('消息已发送，刷新失败：' + reason.message)); }
    catch (reason: any) { setError(reason.message); setFailed(structuredClone(current)); }
    finally { lock.current = false; setSending(false); setPending(undefined); }
  };
  const render = (message: Message) => <ConversationMessage key={message.id} message={message} provider={session.provider} text={sessionMessageText(session, message)} sessionId={session.id} quote={!session.closedAt ? text => edit(session.id, { text: current.text + (current.text ? '\n\n' : '') + quoteSessionText(text), nextTurnOnly: true }) : undefined} sideChat={!session.closedAt && sideChat ? text => sideChat(session, text) : undefined}/>;
  return <section className="subsession-chat" aria-label={'子会话：' + session.title}>
    <header>
      <div className="subsession-heading"><SessionName key={session.id} title={session.title} variant="subsession" save={async title => { await api.call('session.rename', { id: session.id, title }); await changed(); }}/>{session.closedAt ? <span className="muted small" role="status">已关闭</span> : <SessionStatusIndicator session={session}/>}
        <SessionMoreMenu label="更多子会话操作">
          {parent && <div className="session-menu-group"><button type="button" onClick={() => promote(session)}>升级为独立会话</button></div>}
          <div className="session-menu-group">
            <button type="button" disabled={changingAvailability} onClick={() => void changeAvailability()}>{changingAvailability ? (session.closedAt ? '正在打开…' : '正在关闭…') : session.closedAt ? '重新打开' : '关闭会话'}</button>
            {session.closedAt && <button type="button" className="danger" onClick={() => remove(session)}>删除会话</button>}
          </div>
        </SessionMoreMenu>
      </div>
      {parent && <button className="subsession-parent text-button" title={'返回 ' + parent.title} onClick={() => open(parent)}>← {parent.title}</button>}
      <p className="subsession-context-note" title="上下文独立；与父会话共用工作目录，文件修改会相互可见。">上下文独立 · 共用工作目录<SessionDirectoryStatus session={session}/></p>
    </header>
    {children.length > 0 && <details className="subsession-child-list"><summary>下级子会话 · {children.length}</summary><nav className="subsession-child-links" aria-label="下级子会话">{children.map(child => <button key={child.id} title={child.title} onClick={() => open(child)}><span>{child.title}</span><SessionStatusIndicator session={child}/></button>)}</nav></details>}
    <div className="subsession-messages" ref={messages} onScroll={scrolling.onScroll}>
      <SelectionActions sessionId={session.id} add={!session.closedAt ? text => edit(session.id, { text: current.text + (current.text ? '\n\n' : '') + quoteSessionText(text) }) : undefined} sideChat={!session.closedAt && sideChat ? text => sideChat(session, text) : undefined}>
        {session.fork && <details className="inherited-conversation" onToggle={event => { if (event.currentTarget.open && !history) void api.call<Message[]>('subsession.history', { id: session.id }).then(setHistory, reason => setError(reason.message)); }}><summary>创建时的上下文 · {new Date(session.fork.capturedAt).toLocaleTimeString('zh-CN')}{session.fork.parentWasRunning ? ' · 包含当时未完成的回复' : ''}</summary>{history ? <SessionTranscript session={{ ...session, messages: history, status: 'idle' }} renderMessage={render}/> : <p>正在读取固定快照…</p>}</details>}
        <SessionTranscript session={session} renderMessage={render}/>
      </SelectionActions>
      {pending && <PendingSessionMessage pending={pending} messages={session.messages} session={session}/>}
      {running && <p className="muted small">本轮尚未结束。</p>}
      {session.approvals.map(request => <RequestCard key={request.id} request={request} onAnswer={(option, answers) => void action(() => api.call('session.answer', { id: session.id, requestId: request.id, option, answers }))}/>)}
      {scrolling.away && <button className="scroll-latest" onClick={scrolling.latest}>↓ 回到最新消息</button>}
      {failed && <button className="text-button" onClick={() => { if ((current.text.trim() || current.sourceIds.length || current.capabilities?.length) && JSON.stringify(current) !== JSON.stringify(failed)) { setError('输入框中有新的草稿，请先保存草稿后再恢复上一条消息。'); return; } edit(session.id, failed); setFailed(undefined); setError(''); }}>恢复未发送消息到输入框</button>}{(error || session.error) && <p role="alert" className="inline-error">{error || session.error}</p>}
    </div>
    {!session.closedAt && <div className="subsession-composer"><DirectoryMoveNotice key={session.id} session={session} api={api} changed={changed}/><PendingQueueMessage pending={pending}/><SessionInputQueue key={session.id} session={session} activeTurnId={activeTurnId} api={api} changed={changed} locked={locked}/><SessionSyncFrame key={session.id} session={session} api={api} changed={changed} locked={locked || sending || changingAvailability}><div className="composer"><textarea aria-label="子会话输入" disabled={locked} value={current.text} placeholder={locked ? '关联求助正在自动对话' : running ? '输入下一条消息，回车加入队列…' : '在这个分支继续提问…'} onChange={event => edit(session.id, { text: event.target.value })} onKeyDown={event => { if (event.key === 'ArrowUp' && !current.text && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing) { const previous = session.messages.findLast(message => message.role === 'user'); if (previous) { event.preventDefault(); edit(session.id, { text: sessionMessageText(session, previous) }); } return; } if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!event.repeat) void send(); } }}/><div className="composer-bottom"><ComposerSettings key={session.id} session={session}/>{session.provider !== 'claude' && !session.cursorNative && <ComposerMode key={'mode-' + session.id} session={session}/>}<div className="spacer"/><ComposerActions session={session} activeTurnId={activeTurnId} text={current.text} locked={locked} busy={sending || changingAvailability} send={() => void send()} stop={() => void action(() => api.call('session.stop', { id: session.id }))}/></div></div></SessionSyncFrame></div>}
  </section>;
}
