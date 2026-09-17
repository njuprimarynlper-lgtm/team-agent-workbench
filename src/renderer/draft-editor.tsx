import React, { useEffect, useState } from 'react';
import { Upload, Check, LoaderCircle, ArrowLeft, Square } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentSession, Draft, Transfer } from '../shared/types';
import { useAutosave } from './autosave';
const api = window.workbench;
export { contributionStatus as draftStatus } from '../shared/contribution-status';
import { contributionStatus as draftStatus } from '../shared/contribution-status';
import { preparationErrorMessage } from '../shared/preparation-error';
export function DraftEditor({ draft, session, sourceTitle, sourceSession, transfer, run, notice, close }: { draft: Draft; session?: AgentSession; sourceTitle?: string; sourceSession?: AgentSession; transfer?: Transfer; run: <T>(fn: () => Promise<T>) => Promise<T | undefined>; notice: (s: string) => void; close: () => void }) {
  const [busy, setBusy] = useState(false), [submitted, setSubmitted] = useState(false), [expanded, setExpanded] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [showRepo, setShowRepo] = useState(!!draft.repoUrlOverride);
  const [answers, setAnswers] = useState<Record<string, string>>({}), [now, setNow] = useState(Date.now());
  const generating = draft.generation === 'running', ready = draft.generation === 'ready';
  const locked = busy || leaving || submitted || !!draft.submitted;
  const editor = useAutosave('draft-supplement:' + draft.id, { supplement: draft.supplement || '', repoUrlOverride: draft.repoUrlOverride || '' }, value => api.call('draft.supplement', { id: draft.id, ...value }));
  const value = editor.value, repoUrl = value.repoUrlOverride.trim() || draft.repoUrl || '';
  const change = (patch: Partial<typeof value>) => editor.change({ ...value, ...patch });
  const back = () => void run(async () => {
    setLeaving(true);
    try {
      await editor.flush();
      close();
    } finally { setLeaving(false); }
  });
  const stop = () => void run(async () => {
    setLeaving(true);
    try {
      await api.call('draft.cancel', { id: draft.id });
      await editor.flush();
      notice('已停止整理，现有内容已保留');
      close();
    } finally { setLeaving(false); }
  });
  useEffect(() => { setNow(Date.now()); if (!generating) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [generating, draft.generationStartedAt]);
  useEffect(() => { if (ready) setShowRepo(!!draft.repoUrlOverride); }, [draft.repoUrl, ready]);
  const elapsed = Math.max(0, Math.floor((now - Date.parse(draft.generationStartedAt || draft.createdAt)) / 1000));
  const hasNewSource = !!(sourceSession && draft.snapshot && sourceSession.messages.at(-1)?.id !== draft.snapshot.lastMessageId);
  const backLabel = sourceTitle ? `返回“${sourceTitle}”` : '返回原会话';
  const selectedDestination = draft.destinations?.find(item => item.path === draft.target);
  const destinationLabel = generating ? '识别中…' : ready && draft.target ? selectedDestination?.id === 'default' ? '我的成果（自动选择）' : `${selectedDestination?.description || '项目成果'}（自动选择）` : '尚未确定';
  const visibleBody = draft.body.replace(/^#\s+(.+)\r?\n+/u, (full, heading) => heading.trim() === draft.title.trim() ? '' : full);
  const status = generating ? session?.approvals.length ? '需要你确认一项操作' : '正在整理…' : ready ? '已整理好，请确认后上传' : draft.generation === 'error' ? '整理失败，可重试' : '已停止，可重新整理';
  return <div className="draft-editor">
    <div className="draft-editor-heading"><button className="text-button draft-back" title={generating ? '返回不会停止整理' : undefined} disabled={leaving} onClick={back}><ArrowLeft size={15}/><span>{leaving ? '正在返回…' : backLabel}</span></button><span className="spacer"/>{generating && <><span className="muted small">返回后仍会继续整理</span><button className="secondary compact" disabled={leaving} onClick={stop}><Square size={12}/>停止整理</button></>}</div>
    <section className="preparation-summary" aria-label="成果整理进度">
      <div className="preparation-status" aria-live="polite" aria-label="整理状态">{generating && <LoaderCircle size={17} className="spin"/>}<strong>{draft.submitted ? draftStatus(draft, transfer) : status}</strong>{generating && <span className="muted small" aria-label="整理已用时间">{elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`}</span>}{!locked && !generating && !draft.submitted && <button className="text-button" onClick={() => void run(() => { notice(''); return api.call('draft.retry', { id: draft.id }); })}>{draft.generation === 'error' ? '重试' : hasNewSource ? '重新整理并包含新内容' : '重新整理'}</button>}</div>
      <p className="muted small preparation-source">来自“{sourceTitle || '原工作会话'}”{draft.snapshot ? `，采用截至 ${new Date(draft.snapshot.capturedAt).toLocaleString()} 的内容` : ''}{hasNewSource ? '；本次结果不包含原会话新增内容' : ''}</p>
      {draft.generationError && <div className="inline-error" role="alert">{preparationErrorMessage(draft.generationError)}</div>}
      {generating && session?.approvals.map(a => <div className="approval" key={a.id}><strong>{a.title}</strong>{a.summary && <pre className="approval-summary">{a.summary}</pre>}<details><summary>查看请求详情</summary><pre>{a.details}</pre></details>{a.questions?.map(q => <label className="field" key={q.id}>{q.text}{a.method === 'cursor/ask_question' ? <select value={answers[q.id] || ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })}><option value="">选择答案</option>{q.options.map(o => <option key={o}>{o}</option>)}</select> : <input value={answers[q.id] || ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })}/>}</label>)}<div className="row">{a.options.map(o => <button key={o.id} className={o.kind === 'deny' ? 'secondary' : 'primary'} onClick={() => void run(() => api.call('session.answer', { id: session.id, requestId: a.id, option: o.id, answers }))}>{o.label}</button>)}</div></div>)}
    </section>

    {draft.body && <section className="contribution-result" aria-label="整理结果">
      {!ready && !draft.submitted && <p className="muted small">以下是上次整理的内容</p>}
      <h2>{draft.title}</h2>
      {repoUrl && <p className="repository-reference">相关仓库：<a href={repoUrl} onClick={e => { e.preventDefault(); void run(() => api.call('open.link', repoUrl)); }}>{repoUrl}</a></p>}
      <div className={'generated-preview markdown ' + (!expanded && visibleBody.length > 800 ? 'collapsed' : '')} aria-label="整理说明"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:/.test(href)) void run(() => api.call('open.link', href)); }}>{children}</a>, img: ({ alt }) => <span>[图片：{alt || '附件'}]</span> }}>{visibleBody}</ReactMarkdown></div>
      {visibleBody.length > 800 && <button className="text-button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起详情' : '展开详情'}</button>}
    </section>}
    {(ready || draft.body) && !locked && <details className="repository-correction" open={showRepo} onToggle={e => setShowRepo(e.currentTarget.open)}><summary>仓库与代码版本（可选）</summary><label className="field">相关 GitHub 仓库<input aria-label="GitHub 仓库链接" placeholder={draft.repoUrl || 'https://github.com/owner/repository'} value={value.repoUrlOverride} onChange={e => change({ repoUrlOverride: e.target.value })}/></label>{draft.git && <><label className="check-row"><input type="checkbox" aria-label="记录当前代码版本" checked={!!draft.includeGit} onChange={e => void run(() => api.call('draft.git', { id: draft.id, include: e.target.checked }))}/>记录当前代码版本（不会上传代码）</label><p className="muted small git-version">{draft.git.branch} · {draft.git.commit?.slice(0, 12) || '无提交'} · {draft.git.dirty ? '有未提交改动' : '无未提交改动'}</p></>}</details>}
    {transfer?.status === 'error' && <div className="inline-error" role="alert">上传失败：{transfer.error}<div className="row"><button className="secondary" onClick={() => void run(() => api.call('transfer.retry', { id: transfer.id }))}>重试原上传</button><button className="secondary" onClick={() => void run(async () => { await api.call('draft.revise', { id: draft.id }); notice('修订草稿已创建，可在上方草稿列表选择并补充后上传'); })}>生成修订草稿</button></div></div>}
    <label className="field contribution-supplement">给团队的补充（可选）<textarea rows={3} aria-label="给团队的补充（可选）" placeholder="只有需要补充或更正时填写" disabled={locked} value={value.supplement} onChange={e => change({ supplement: e.target.value })}/></label>
    {!locked && editor.status !== '已保存' && <div className="row small muted" role="status"><span>{editor.status}</span>{editor.status.startsWith('保存失败') && <button className="text-button" onClick={editor.retry}>重试保存</button>}</div>}
    <div className="upload-destination" aria-label="上传位置" title={ready ? draft.target : undefined}><span>上传位置</span>{draft.binding ? <b>{draft.binding.project.name} / {destinationLabel}</b> : <b>未绑定项目，无法上传</b>}</div>
    <div className="draft-actions">{!draft.submitted && !submitted ? <>{draft.body && <button className="secondary back-action" disabled={leaving} onClick={back}>{backLabel}</button>}<span className="spacer"/><button className="primary" disabled={busy || leaving || !ready || !draft.body.trim() || !draft.binding} onClick={() => void run(async () => { setBusy(true); try { await editor.flush(); await api.call('draft.submit', { id: draft.id }); setSubmitted(true); notice('已开始上传，可在传输记录中查看'); } finally { setBusy(false); } })}><Upload size={15}/>{busy ? '正在上传…' : '确认上传'}</button></> : <><button className="secondary back-action" onClick={back}>{backLabel}</button><span className="green row"><Check size={17}/>{transfer?.status === 'done' ? '已上传到公共区' : transfer?.status === 'error' ? '上传失败，可重试或生成修订草稿' : '正在上传'}</span></>}</div>
  </div>;
}
