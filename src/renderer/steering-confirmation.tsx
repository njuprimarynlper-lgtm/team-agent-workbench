import React from 'react';
import type { AgentSession, SessionInput } from '../shared/types';
import { composerMode } from './composer-actions';

export interface SteeringReview { sessionId: string; sessionTitle: string; turnId: string; input: SessionInput; references: string[] }
export function prepareSteeringReview(session: AgentSession, input: SessionInput, turnId: string, references: string[] = []): SteeringReview {
  if (composerMode(session, turnId) !== 'steer' || !input.text.trim()) throw new Error('当前任务尚未就绪，不能发送引导');
  return { sessionId: session.id, sessionTitle: session.title, turnId, input: structuredClone(input), references: [...references] };
}
export function steeringReviewIsCurrent(review: SteeringReview, session?: AgentSession, activeTurnId?: string) {
  return !!session && session.id === review.sessionId && activeTurnId === review.turnId && composerMode(session, activeTurnId) === 'steer';
}
export async function confirmSteeringReview(review: SteeringReview, session: AgentSession | undefined, activeTurnId: string | undefined, submit: () => Promise<unknown>) {
  if (!steeringReviewIsCurrent(review, session, activeTurnId)) throw new Error('原任务已结束或发生变化，引导未发送；请返回输入框重新确认');
  return submit();
}
export function SteeringConfirmation({ review, current, busy, error, close, confirm }: {
  review: SteeringReview; current: boolean; busy: boolean; error: string; close: () => void; confirm: () => void;
}) {
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="steering-confirm-title">
    <header><h2 id="steering-confirm-title">确认引导当前任务？</h2><button className="icon" aria-label="取消引导" disabled={busy} onClick={close}>×</button></header>
    <div className="modal-body"><p>会话：{review.sessionTitle}</p><p className="muted small">确认后将以下补充要求发送给正在进行的任务，不会新开一轮。</p>
      <pre aria-label="待确认的引导内容" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{review.input.text}</pre>
      {!!review.references.length && <details><summary>同时带入的参考内容（{review.references.length}）</summary><ul>{review.references.map((name, index) => <li key={index}>{name}</li>)}</ul></details>}
      {!!review.input.capabilities?.length && <p>附带能力：{review.input.capabilities.map(item => item.name).join('、')}</p>}
      {!current && <p className="inline-error" role="alert">原任务已结束或发生变化，引导未发送。取消后可返回输入框重新确认。</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div><footer><button className="secondary" autoFocus disabled={busy} onClick={close}>取消，保留输入</button><button className="primary" disabled={busy || !current} onClick={confirm}>{busy ? '正在发送…' : '确认发送引导'}</button></footer>
  </section></div>;
}
