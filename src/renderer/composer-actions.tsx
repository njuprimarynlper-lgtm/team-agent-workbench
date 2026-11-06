import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, LoaderCircle, Square } from 'lucide-react';
import type { AgentSession, FollowUpMode, SessionInput } from '../shared/types';
import { cursorSharedSessionUnavailable, isCursorFileSession } from '../shared/cursor-session-consistency';

export function composerMode(session: Pick<AgentSession, 'provider' | 'status' | 'closedAt' | 'cursorNative' | 'contextCompacting'>, _activeTurnId?: string): 'send' | 'queue' | 'wait' {
  if (session.closedAt) return 'wait';
  if (isCursorFileSession(session)) return 'send';
  if (session.cursorNative) return 'wait';
  if (session.contextCompacting || ['starting', 'running', 'approval'].includes(session.status)) return 'queue';
  return 'send';
}

export function followUpAction(session: AgentSession, turnId: string | undefined, input: SessionInput, preference: FollowUpMode = 'queue', invert = false) {
  const mode = composerMode(session, turnId);
  if (mode === 'queue' && session.provider === 'codex' && turnId && !session.contextCompacting && !input.nextTurnOnly && !session.stoppedAt)
    return (preference === 'steer') !== invert ? 'steer' : 'queue';
  return mode === 'send' && session.inputQueue?.items.length ? 'queue' : mode;
}

export function followUpShortcut(session: AgentSession, turnId: string | undefined, input: SessionInput, preference?: FollowUpMode) {
  if (input.editingQueueItemId) return 'Enter 保存 · Esc 取消';
  const normal = followUpAction(session, turnId, input, preference);
  const alternate = followUpAction(session, turnId, input, preference, true);
  const labels = { queue: '排队', steer: '引导', send: '发送', wait: '等待' };
  const modifier = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';
  return 'Enter ' + labels[normal] + (normal !== alternate ? ' · ' + modifier + '+Enter ' + labels[alternate] : '');
}

export function ComposerActions({ session, activeTurnId, text, busy, locked, send, stop, resume, followUpMode, nextTurnOnly }: {
  session: AgentSession; activeTurnId?: string; text: string; busy: boolean; locked?: boolean; send: () => void; stop: () => void; resume?: () => void; followUpMode?: FollowUpMode; nextTurnOnly?: boolean;
}) {
  const mode = composerMode(session, activeTurnId), active = ['starting', 'running', 'approval'].includes(session.status);
  const action = followUpAction(session, activeTurnId, { text, nextTurnOnly, sourceIds: [], answers: {} }, followUpMode);
  const sendLabel = busy ? '正在提交消息' : session.inputQueue?.editing ? '保存排队消息' : session.contextCompacting ? '压缩后发送' : action === 'steer' ? '引导当前任务' : action === 'queue' ? '加入队列' : '发送任务';
  const stopButton = useRef<HTMLButtonElement>(null), stopAction = useRef(stop); stopAction.current = stop;
  const [confirmStop, setConfirmStop] = useState(false);
  useEffect(() => {
    setConfirmStop(false);
    const composer = stopButton.current?.closest<HTMLElement>('.composer');
    if (!active || locked || session.inputQueue?.editing || !composer) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); event.stopPropagation();
      if (timer) { clearTimeout(timer); timer = undefined; setConfirmStop(false); stopAction.current(); }
      else { setConfirmStop(true); timer = setTimeout(() => { timer = undefined; setConfirmStop(false); }, 1800); }
    };
    // Listen after editor/menu shortcuts have consumed Escape.
    const listen = (event: KeyboardEvent) => { if (composer.contains(event.target as Node)) key(event); };
    window.addEventListener('keydown', listen); return () => { clearTimeout(timer); window.removeEventListener('keydown', listen); };
  }, [active, locked, session.id, activeTurnId, session.inputQueue?.editing?.itemId]);
  const paused = !!session.stoppedAt && !active;
  if (session.closedAt) return null;
  if (locked) return <button className="send" aria-label="发送任务" disabled title="自动对话进行中，不能手动发送"><ArrowUp size={20}/></button>;
  if (session.cursorNative && !isCursorFileSession(session)) return <button className="send" aria-label="发送任务" disabled title={cursorSharedSessionUnavailable}><ArrowUp size={20}/></button>;
  return <>
    {paused && !session.inputQueue?.items.length && resume && <button className="primary compact" aria-label="继续对话" title="从停下的地方继续这次对话" disabled={busy} onClick={resume}>继续</button>}
    {mode !== 'wait' && <button className="send" aria-label={sendLabel} title={sendLabel} disabled={!text.trim() || busy} onClick={send}>{busy ? <LoaderCircle size={18} className="spin"/> : <ArrowUp size={20}/>}</button>}
    {confirmStop && <span role="status">再按 Esc 停止</span>}
    {active && <button ref={stopButton} className={'send stop' + (session.stoppedAt ? ' is-stopping' : '')} aria-label={session.stoppedAt ? '正在停止当前任务' : '停止当前任务'} title={session.stoppedAt ? '正在停止当前任务' : '停止当前任务'} onClick={stop}>{session.stoppedAt ? '正在停止' : <Square size={15}/>}</button>}
  </>;
}
