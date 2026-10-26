import React, { useId, useState } from 'react';
import { MessageSquare, ShieldCheck } from 'lucide-react';
import type { Approval } from '../shared/types';
import ReactMarkdown from './math-markdown';
import remarkGfm from 'remark-gfm';

export type RequestAnswers = Record<string, string | string[]>;
export const isQuestionRequest = (request: Approval) => request.method === 'item/tool/requestUserInput' || request.method === 'cursor/ask_question' || (request.method === 'claude/can_use_tool' && !!request.questions?.length);
export const isPlanRequest = (request: Approval) => request.method === 'cursor/create_plan';

export function RequestCard({ request, onAnswer }: { request: Approval; onAnswer: (option: string, answers: RequestAnswers) => void }) {
  const fieldId = useId();
  const [answers, setAnswers] = useState<RequestAnswers>({});
  const [editing, setEditing] = useState(false), [plan, setPlan] = useState(request.details);
  if (request.method === 'cursor/create_plan') return <section className="approval proposed-plan" aria-label="Cursor 实施计划"><strong>{request.title}</strong>{editing ? <textarea className="plan-editor" aria-label="修改 Cursor 计划" value={plan} onChange={event => setPlan(event.target.value)}/> : <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{request.details}</ReactMarkdown></div>}<div className="row">{editing ? <><button className="secondary" onClick={() => setEditing(false)}>取消修改</button><button className="primary" disabled={!plan.trim()} onClick={() => onAnswer('decline', { reason: '请按以下修订重新制定计划，等待确认：\n\n' + plan })}>提交修改</button></> : <><button className="secondary" onClick={() => setEditing(true)}>修改计划</button><button className="primary" onClick={() => onAnswer('accept', {})}>执行计划</button><button className="secondary" onClick={() => onAnswer('cancel', {})}>取消</button></>}</div></section>;
  const question = isQuestionRequest(request);
  const complete = request.questions?.length && request.questions.every(q => {
    const value = answers[q.id];
    return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && !!value.trim();
  });
  return <div className={'approval' + (question ? ' question-request' : '')} role="group" aria-label={request.title}>
    <strong>{question ? <MessageSquare size={17}/> : <ShieldCheck size={17}/>} {request.title}</strong>
    {request.summary && <pre className="approval-summary">{request.summary}</pre>}
    {!question && <details><summary>查看请求详情</summary><pre>{request.details}</pre></details>}
    {request.questions?.map(q => {
      const value = answers[q.id], selected = Array.isArray(value) ? value : [];
      // Cursor's structured protocol requires option IDs; Codex and Claude
      // accept the visible answer (including free text). Keep that boundary.
      const choiceValue = (option: typeof q.options[number]) => request.method === 'cursor/ask_question' || q.allowMultiple ? option.id : option.label;
      return <fieldset className="question-field" key={q.id}><legend>{q.text}{q.allowMultiple ? '（可多选）' : ''}</legend>
        <div className="question-options">{q.options.map(option => <label className="question-option" key={option.id}>
          <input type={q.allowMultiple ? 'checkbox' : 'radio'} name={`${fieldId}-${q.id}`} aria-label={option.label} checked={q.allowMultiple ? selected.includes(option.id) : value === choiceValue(option)} onChange={event => setAnswers(current => ({ ...current, [q.id]: q.allowMultiple ? event.target.checked ? [...selected, option.id] : selected.filter(id => id !== option.id) : choiceValue(option) }))}/>
          <span>{option.label}</span>
        </label>)}</div>
        {!q.allowMultiple && (request.method !== 'cursor/ask_question' || !q.options.length) && <label className="field question-custom">{q.options.length ? '或输入其他答案' : '你的回答'}<input aria-label={q.text} placeholder={q.options.length ? '输入其他答案…' : '输入回答…'} value={typeof value === 'string' && !q.options.some(option => choiceValue(option) === value) ? value : ''} onChange={event => setAnswers(current => ({ ...current, [q.id]: event.target.value }))}/></label>}
      </fieldset>;
    })}
    <div className="row">{request.options.map(o => <button key={o.id} className={o.kind === 'deny' ? 'secondary' : 'primary'} disabled={o.id === 'answer' && !complete} onClick={() => onAnswer(o.id, answers)}>{o.label}</button>)}</div>
  </div>;
}
