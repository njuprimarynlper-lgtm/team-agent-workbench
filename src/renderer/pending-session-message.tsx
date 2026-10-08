import React from 'react';
import type { Message } from '../shared/types';

export interface PendingMessage { text: string; beforeMessageCount: number; phase: 'matching' | 'submitting' }

export function PendingSessionMessage({ pending, messages }: { pending: PendingMessage; messages: Message[] }) {
  if (messages.slice(pending.beforeMessageCount).some(message => message.role === 'user' && (message.userText ?? message.text) === pending.text)) return null;
  return <article className="message user message-pending" role="status" aria-label="消息正在提交">
    <div className="message-author"><span className="provider-icon user">我</span><b>你</b><span className="pending-message-state"><span className="status-pulse"/>{pending.phase === 'matching' ? '正在检查相关成果…' : '正在提交，等待 CLI 确认…'}</span></div>
    <div className="pending-message-text">{pending.text}</div>
  </article>;
}
