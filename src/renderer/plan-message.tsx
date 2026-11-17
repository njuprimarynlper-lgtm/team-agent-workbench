import { submissionMayHaveArrived } from './submission-failure';
import { ErrorLogLink } from './error-notice';
import { uiErrorMessage, userFailure } from '../shared/user-failure';
import { MarkdownEditor } from './markdown-editor';
import React, { useState } from 'react';
import type { AgentSession, Message, Snapshot } from '../shared/types';

export function PlanMessage({ session, message, render }: { session: AgentSession; message: Message; render: (text: string) => React.ReactNode }) {
  const [editing, setEditing] = useState(false), [text, setText] = useState(message.text), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [locallyUnknown, setSubmissionUnknown] = useState(false), [acceptedLocally, setAcceptedLocally] = useState(false);
  const submissionUnknown = locallyUnknown || !!session.proposedPlan?.submissionUnknown;
  if (message.kind === 'planSteps') return <div className="plan-steps" aria-label="计划进度">{message.steps?.map((step, index) => <div className={'plan-step ' + step.status} key={index}><span>{step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '◉' : step.status === 'cancelled' ? '—' : '○'}</span><span>{step.text}</span></div>)}</div>;
  const current = session.proposedPlan?.messageId === message.id, ready = current && session.proposedPlan?.ready && !session.proposedPlan.accepted && !submissionUnknown && !acceptedLocally && session.status === 'idle' && !session.closedAt;
  const failed = (reason: unknown, operation: string) => {
    const failure = userFailure(reason, { domain: 'cli', operation });
    const unknown = submissionMayHaveArrived(failure, true);
    setSubmissionUnknown(unknown);
    setError(unknown ? '还不知道这个计划是否已开始。先点“刷新执行状态”；如果已有执行进展，就等它完成。仍看不出来时先别再次执行。' : failure.message);
  };
  const refreshExecution = async () => {
    setBusy(true);
    try {
      const snapshot = await window.workbench.call<Snapshot>('snapshot');
      const latest = snapshot.sessions.find(item => item.id === session.id);
      if (latest?.proposedPlan?.messageId === message.id && latest.proposedPlan.accepted) { setAcceptedLocally(true); setSubmissionUnknown(false); setError('计划已提交，请在本会话查看执行进展。'); }
      else {
        setAcceptedLocally(false); setSubmissionUnknown(true);
        setError(latest && ['running', 'starting', 'approval'].includes(latest.status) ? '这个会话有任务正在处理，但还不知道是不是这个计划。请查看本会话的任务和回复；如果是这个计划就等待，没看清之前先别再次执行。' : '刷新后仍没有这个计划已开始的记录。请查看本会话的回复：如果已经在执行就等待；确认没有开始，再点“确认没有开始，允许重试”。');
      }
    } catch (reason) { setError('这次没读到执行状态，请稍后再点“刷新执行状态”。' + uiErrorMessage(reason, { domain: 'cli', operation: '刷新计划执行状态' })); }
    finally { setBusy(false); }
  };
  const execute = async () => {
    if (!ready || busy) return;
    setBusy(true); setError('');
    try { const sent = await window.workbench.call('session.plan.execute', { id: session.id, messageId: message.id }); if (!sent) setError('计划未开始执行，请检查会话状态后重试。'); else setAcceptedLocally(true); }
    catch (reason) { failed(reason, '提交计划执行'); } finally { setBusy(false); }
  };
  const allowRetry = async () => {
    setBusy(true);
    try { await window.workbench.call('session.plan.confirmRetry', { id: session.id, messageId: message.id }); setSubmissionUnknown(false); setError('现在可以重新提交。点“执行计划”才会开始，当前还没有重新发送。'); }
    catch (reason) { setError(uiErrorMessage(reason, { domain: 'cli', operation: '记录计划执行核对' })); }
    finally { setBusy(false); }
  };
  return <section className="proposed-plan" aria-label="实施计划"><strong>实施计划</strong>{editing ? <MarkdownEditor aria-label="修改实施计划" className="plan-editor" value={text} onChange={event => setText(event.target.value)}/> : render(message.text)}
    {error && <p role="alert" className="inline-error">{error} <ErrorLogLink message={error}/></p>}
    {submissionUnknown && <div className="row"><button className="secondary compact" disabled={busy} onClick={() => void refreshExecution()}>刷新执行状态</button><button className="text-button" disabled={busy} onClick={() => void allowRetry()}>确认没有开始，允许重试</button></div>}
    {current && <div className="row">{editing ? <><button className="secondary compact" disabled={busy} onClick={() => setEditing(false)}>取消修改</button><button className="primary compact" disabled={!ready || busy || !text.trim()} onClick={async () => { setBusy(true); setError(''); try { const sent = await window.workbench.call('session.plan.revise', { id: session.id, messageId: message.id, text }); if (sent) setEditing(false); else setError('修改未发送，请重试。'); } catch (reason) { failed(reason, '提交计划修改'); } finally { setBusy(false); } }}>提交修改</button></> : <><button className="secondary compact" disabled={!ready || busy} onClick={() => { setText(message.text); setEditing(true); }}>修改计划</button><button className="primary compact" disabled={!ready || busy} onClick={() => void execute()}>{session.proposedPlan?.accepted || acceptedLocally ? '已开始执行' : submissionUnknown ? '计划提交待确认' : busy ? '正在提交…' : '执行计划'}</button></>}</div>}
  </section>;
}
