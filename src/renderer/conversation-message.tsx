import React, { useState } from 'react';
import { Puzzle } from 'lucide-react';
import type { Message, Provider } from '../shared/types';
import { Markdown } from './markdown';
import { CursorNativeRecord } from './cursor-native-record';
import { CopyTextButton } from './copy-text-button';
import { MessageTime } from './turn-timing';
import { ContextMenu, contextAnchor, type ContextAnchor, type ContextAction } from './context-menu';

export function ConversationMessage({ message, provider, text = message.text, sessionId, openFile, pendingLabel, children, quote, sideChat }: {
  message: Message; provider: Provider; text?: string; sessionId?: string;
  openFile?: (path: string) => void; pendingLabel?: string; children?: React.ReactNode;
  quote?: (text: string) => void; sideChat?: (text: string) => void;
}) {
  const [menu, setMenu] = useState<{ anchor: ContextAnchor; selected: string }>();
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
      {children ?? (message.role === 'tool' ? <details><summary>{text.split('\n')[0]?.slice(0, 130) || '查看工具事件'}</summary><pre>{text}</pre></details> : <Markdown text={text} sessionId={sessionId} openFile={openFile} conversation/>)}
      {user && !!message.context?.capabilities?.length && <div className="message-capabilities">{message.context.capabilities.map(item => <span key={item.id}><Puzzle size={11}/>{item.name}</span>)}</div>}
      <CursorNativeRecord message={message}/>
      {(assistant || user) && !!text.trim() && <footer className="conversation-message-footer"><CopyTextButton text={text} label={user ? '复制这条消息' : '复制这条回复'}/></footer>}
    </div>
    {menu && <ContextMenu anchor={menu.anchor} label="消息操作" actions={actions} close={() => setMenu(undefined)}/>}
  </article>;
}
