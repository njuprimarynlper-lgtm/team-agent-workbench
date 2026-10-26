import React from 'react';
import type { AgentSession, Message } from '../shared/types';
import { sessionMessageText } from '../shared/session-context-text';

export interface PendingMessage { text: string; beforeMessageCount: number; phase: 'matching' | 'submitting' | 'queueing' }

export function PendingQueueMessage({ pending }: { pending?: PendingMessage }) {
  return pending?.phase === 'queueing' ? <div className="session-input-queue" role="status" aria-label="正在加入待发送队列"><div className="queue-row"><span className="queue-number">…</span><span className="queue-text">{pending.text.replace(/\s*\r?\n\s*/g, ' ')}</span><small>正在排队…</small></div></div> : null;
}

export function PendingSessionMessage({ pending, messages, session }: { pending: PendingMessage; messages: Message[]; session?: AgentSession }) {
  if (pending.phase === 'queueing') return null;
  if (messages.slice(pending.beforeMessageCount).some(message => message.role === 'user' && (session ? sessionMessageText(session, message) : message.userText ?? message.text) === pending.text)) return null;
  return <article className="message conversation-message user message-pending" role="status" aria-label="消息正在提交"><div className="message-surface">
    <div className="message-author"><span className="pending-message-state"><span className="status-pulse"/>{pending.phase === 'matching' ? '正在检查相关成果…' : session?.cursorNative ? '正在加入 Cursor 等待队列…' : '正在发送…'}</span></div>
    <div className="pending-message-text">{pending.text}</div>
  </div></article>;
}
