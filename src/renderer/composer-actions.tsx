import React from 'react';
import { ArrowUp, LoaderCircle, Square } from 'lucide-react';
import type { AgentSession } from '../shared/types';
import { cursorSharedSessionUnavailable, isCursorFileSession } from '../shared/cursor-session-consistency';

export function composerMode(session: Pick<AgentSession, 'provider' | 'status' | 'closedAt' | 'cursorNative'>, _activeTurnId?: string): 'send' | 'queue' | 'wait' {
  if (session.closedAt) return 'wait';
  if (isCursorFileSession(session)) return 'send';
  if (session.cursorNative) return 'wait';
  if (['starting', 'running', 'approval'].includes(session.status)) return 'queue';
  return 'send';
}

export function ComposerActions({ session, activeTurnId, text, busy, locked, send, stop, resume }: {
  session: AgentSession; activeTurnId?: string; text: string; busy: boolean; locked?: boolean; send: () => void; stop: () => void; resume?: () => void;
}) {
  const mode = composerMode(session, activeTurnId), active = ['starting', 'running', 'approval'].includes(session.status);
  const paused = !!session.stoppedAt && !active;
  if (session.closedAt) return null;
  if (locked) return <button className="send" aria-label="发送任务" disabled title="自动对话进行中，不能手动发送"><ArrowUp size={20}/></button>;
  if (session.cursorNative && !isCursorFileSession(session)) return <button className="send" aria-label="发送任务" disabled title={cursorSharedSessionUnavailable}><ArrowUp size={20}/></button>;
  return <>
    {paused && !session.inputQueue?.items.length && resume && <button className="primary compact" aria-label="继续对话" title="从停下的地方继续这次对话" disabled={busy} onClick={resume}>继续</button>}
    {mode !== 'wait' && <button className="send" aria-label={busy ? '正在提交消息' : mode === 'queue' || session.inputQueue?.items.length ? '加入队列' : '发送任务'} title={busy ? '正在提交消息' : mode === 'queue' || session.inputQueue?.items.length ? '加入队列' : '发送任务'} disabled={!text.trim() || busy} onClick={send}>{busy ? <LoaderCircle size={18} className="spin"/> : <ArrowUp size={20}/>}</button>}
    {active && <button className={'send stop' + (session.stoppedAt ? ' is-stopping' : '')} aria-label={session.stoppedAt ? '正在停止当前任务' : '停止当前任务'} title={session.stoppedAt ? '正在停止当前任务' : '停止当前任务'} onClick={stop}>{session.stoppedAt ? '正在停止' : <Square size={15}/>}</button>}
  </>;
}
