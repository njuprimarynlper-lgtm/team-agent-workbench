import { submissionMayHaveArrived } from './submission-failure';
import { contextualError } from './contextual-error';
import { ErrorLogLink } from './error-notice';
import { uiErrorMessage, userFailure } from '../shared/user-failure';
import React, { useState } from 'react';
import { MarkdownEditor } from './markdown-editor';
import { Pencil, Puzzle } from 'lucide-react';
import type { Message, Provider, Snapshot } from '../shared/types';
import { Markdown } from './markdown';
import { CursorNativeRecord } from './cursor-native-record';
import { CopyTextButton } from './copy-text-button';
import { MessageTime } from './turn-timing';
import { PagedMessageText } from './paged-message-text';
import { ContextMenu, contextAnchor, type ContextAnchor, type ContextAction } from './context-menu';

export const ConversationMessage = React.memo(function ConversationMessage({ message, provider, text = message.text, sessionId, openFile, pendingLabel, children, quote, sideChat, editLast }: {
  message: Message; provider: Provider; text?: string; sessionId?: string;
  openFile?: (path: string) => void; pendingLabel?: string; children?: React.ReactNode;
  editLast?: (value: string) => Promise<void>;
  quote?: (text: string) => void; sideChat?: (text: string) => void;
}) {
  const [menu, setMenu] = useState<{ anchor: ContextAnchor; selected: string }>();
  const [edit, setEdit] = useState<string>(), [saving, setSaving] = useState(false), [editError, setEditError] = useState(''), [editUncertain, setEditUncertain] = useState(false);
  const save = async () => {
    if (!editLast || !edit?.trim() || saving || editUncertain) return;
    setSaving(true); setEditError('');
    try { await editLast(edit); setEdit(undefined); } catch (reason: any) { setEditUncertain(submissionMayHaveArrived(userFailure(reason, { domain: 'cli', operation: '重新发送修改后的消息' }), true)); setEditError(contextualError(reason, { domain: 'cli', operation: '重新发送修改后的消息' }, { UNCLASSIFIED_FAILURE: '修改内容还在输入框中，但没拿到重新发送的结果。先查看本会话最后一条消息：已出现修改后的内容就等回复；没有出现时先别重发，稍后再查看。' })); }
    finally { setSaving(false); }
  };
  const refreshEditedTurn = async () => {
    if (!sessionId || saving) return;
    setSaving(true);
    try {
      const snapshot = await window.workbench.call<Snapshot>('snapshot');
      const latest = snapshot.sessions.find(session => session.id === sessionId)?.messages.findLast(item => item.role === 'user');
      setEditError(latest && latest.id !== message.id && (latest.userText || latest.text) === edit ? '最新对话已经显示修改后的消息，请在本会话查看回复。先不要再次发送。' : '最新对话里暂时没看到修改后的消息，仍不知道是否已经发出。先别重发，稍后再点“刷新会话状态”。');
    } catch { setEditError('这次没读到最新会话状态。修改内容还在，请稍后再点“刷新会话状态”，先别重新发送。'); }
    finally { setSaving(false); }
  };
  const user = message.role === 'user', assistant = message.role === 'assistant';
  const name = user ? '你' : assistant ? provider === 'codex' ? 'Codex' : provider === 'cursor' ? 'Cursor' : 'Claude Code' : message.role === 'tool' ? '工具执行' : '运行信息';
  const member = user && !!message.context?.questionRunId;
  const showMetadata = !user || member || message.steering || pendingLabel;
  const time = <MessageTime at={message.createdAt}/>;
  const actions: ContextAction[] = [
    ...(menu?.selected ? [{ label: '复制所选文本', run: () => window.workbench.call('copy', menu.selected) }] : []),
    { label: '复制消息', run: () => window.workbench.call('copy', text), disabled: !text.trim() },
    ...(quote ? [{ label: '添加到会话', separator: true, run: () => quote(menu?.selected || text), disabled: !text.trim() }] : []),
    ...(sideChat ? [{ label: '侧边提问', run: () => sideChat(menu?.selected || text), disabled: !text.trim() }] : []),
  ];
  return <article tabIndex={0} onContextMenu={event => {
    if ((event.target as HTMLElement).closest('input,textarea,a,button')) return;
    const selection = window.getSelection();
    const selected = selection && event.currentTarget.contains(selection.anchorNode) && event.currentTarget.contains(selection.focusNode) ? selection.toString() : '';
    setMenu({ anchor: contextAnchor(event), selected });
  }} className={'message conversation-message ' + message.role + (pendingLabel ? ' message-pending is-question' : '')} aria-label={name + '的消息'}>
    {user && <div className="conversation-user-time">{time}</div>}
    <div className="message-surface">
      {showMetadata && <div className="message-author"><b>{name}</b>{message.steering && <span className="badge">引导</span>}{member && <span className="badge">成员消息</span>}{pendingLabel && <span className="pending-message-state question" role="status"><span className="status-pulse"/>{pendingLabel}</span>}{!user && time}</div>}
      {edit !== undefined ? <div className="sent-message-edit"><MarkdownEditor autoFocus aria-label="编辑上一条消息" value={edit} disabled={saving} onChange={e => setEdit(e.target.value)} onKeyDown={e => {
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEdit(undefined); }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!e.repeat) void save(); }
      }}/><small>发送后将重新生成这一轮，已执行的文件修改会保留。</small>
        {editError && <p role="alert" className="inline-error">{editError} <ErrorLogLink message={editError}/></p>}
        <div>{editUncertain && sessionId && <button type="button" className="secondary compact" disabled={saving} onClick={() => void refreshEditedTurn()}>刷新会话状态</button>}<button type="button" className="text-button" disabled={saving} onClick={() => setEdit(undefined)}>取消</button><button type="button" className="primary compact" disabled={saving || editUncertain || !edit.trim() || !editLast} onClick={() => void save()}>{editUncertain ? '发送结果未知，暂不重发' : '重新发送'}</button></div>
      </div> : <PagedMessageText text={text} render={part => part === text && children ? children : message.role === 'tool'
        ? <details><summary>{text.split('\n')[0]?.slice(0, 130) || '查看工具事件'}</summary><pre>{part}</pre></details>
        : <Markdown text={part} sessionId={sessionId} openFile={openFile} conversation/>}/>}
      {user && !!message.context?.capabilities?.length && <div className="message-capabilities">{message.context.capabilities.map(item => <span key={item.id}><Puzzle size={11}/>{item.name}</span>)}</div>}
      <CursorNativeRecord message={message}/>
      {(assistant || user) && !!text.trim() && <footer className="conversation-message-footer">{editLast && edit === undefined && <button type="button" className="icon" aria-label="编辑上一条消息" title="编辑上一条消息" onClick={() => { setEditError(''); setEdit(text); }}><Pencil size={13}/></button>}<CopyTextButton text={text} label={user ? '复制这条消息' : '复制这条回复'}/></footer>}
    </div>
    {menu && <ContextMenu anchor={menu.anchor} label="消息操作" actions={actions} close={() => setMenu(undefined)}/>}
  </article>;
}, (before, after) => before.message === after.message && before.text === after.text && before.provider === after.provider && before.sessionId === after.sessionId && before.pendingLabel === after.pendingLabel && !!before.quote === !!after.quote && !!before.sideChat === !!after.sideChat && !!before.editLast === !!after.editLast && !before.children && !after.children);
