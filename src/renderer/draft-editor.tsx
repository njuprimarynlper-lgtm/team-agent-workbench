import React, { useEffect, useState } from 'react';
import { Upload, Check, Sparkles, LoaderCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentSession, Draft } from '../shared/types';
import { useAutosave } from './autosave';
const api = window.workbench;
export function draftStatus(draft: Draft) {
  return draft.submitted ? '已提交' : draft.generation === 'running' ? '整理中' : draft.generation === 'error' ? '整理失败' : draft.generation === 'canceled' ? '已停止' : '待确认';
}
export function DraftEditor({ draft, session, sourceTitle, run, notice }: { draft: Draft; session?: AgentSession; sourceTitle?: string; run: <T>(fn: () => Promise<T>) => Promise<T | undefined>; notice: (s: string) => void }) {
  const [busy, setBusy] = useState(false), [submitted, setSubmitted] = useState(false), [expanded, setExpanded] = useState(false);
  const [showRepo, setShowRepo] = useState(!draft.repoUrl || !!draft.repoUrlOverride);
  const [answers, setAnswers] = useState<Record<string, string>>({}), [now, setNow] = useState(Date.now());
  const generating = draft.generation === 'running', ready = draft.generation === 'ready';
  const locked = busy || submitted || !!draft.submitted;
  const editor = useAutosave('draft-supplement:' + draft.id, { supplement: draft.supplement || '', repoUrlOverride: draft.repoUrlOverride || '' }, value => api.call('draft.supplement', { id: draft.id, ...value }));
  const value = editor.value, repoUrl = value.repoUrlOverride.trim() || draft.repoUrl || '';
  const change = (patch: Partial<typeof value>) => editor.change({ ...value, ...patch });
  useEffect(() => { setNow(Date.now()); if (!generating) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [generating, draft.generationStartedAt]);
  useEffect(() => { if (ready) setShowRepo(!draft.repoUrl || !!draft.repoUrlOverride); }, [draft.repoUrl, ready]);
  const elapsed = Math.max(0, Math.floor((now - Date.parse(draft.generationStartedAt || draft.createdAt)) / 1000));
  const status = generating ? session?.approvals.length ? '整理需要确认下方 CLI 请求。' : 'AI 正在整理成果……' : ready ? '整理完成，待确认上传。' : draft.generation === 'error' ? '整理失败，补充说明已保留。' : '已停止整理，可以重新整理。';
  return <div className="draft-editor">
    <section className={"preparation-panel" + (ready || draft.submitted ? " complete" : "")} aria-label="成果整理进度">
      <div className="row"><Sparkles size={19}/><b>整理成果</b><span className="spacer"/><span className="badge" aria-label="成果状态">{draftStatus(draft)}</span></div>
      <p className="muted small preparation-source">来源：{sourceTitle || '原工作会话'} · {draft.binding?.project.name || '本地会话'}</p>
      {!draft.submitted && <><div className="preparation-status" aria-live="polite" aria-label="整理状态">{generating && <LoaderCircle size={19} className="spin"/>}<strong>{status}</strong>{generating && <span className="muted small" aria-label="整理已用时间">已用时 {elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`}</span>}</div>
      {generating && <p className="muted small">{draft.generationStage === 'directories' ? '正在读取当前项目的目录信息。' : '正在根据交接材料生成说明，并识别上传位置。'}你可以继续工作，整理结果会保留在这里。</p>}
      {draft.generationError && <div className="inline-error" role="alert">{draft.generationError}</div>}
      {!locked && <div className="row preparation-controls"><button className="secondary compact" onClick={() => void run(() => { notice(''); return api.call(generating ? 'draft.cancel' : 'draft.retry', { id: draft.id }); })}>{generating ? '停止整理' : draft.generation === 'error' ? '重试整理' : '重新整理'}</button></div>}</>}
      {generating && session?.approvals.map(a => <div className="approval" key={a.id}><strong>{a.title}</strong><details><summary>查看请求详情</summary><pre>{a.details}</pre></details>{a.questions?.map(q => <label className="field" key={q.id}>{q.text}{a.method === 'cursor/ask_question' ? <select value={answers[q.id] || ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })}><option value="">选择答案</option>{q.options.map(o => <option key={o}>{o}</option>)}</select> : <input value={answers[q.id] || ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })}/>}</label>)}<div className="row">{a.options.map(o => <button key={o.id} className={o.kind === 'deny' ? 'secondary' : 'primary'} onClick={() => void run(() => api.call('session.answer', { id: session.id, requestId: a.id, option: o.id, answers }))}>{o.label}</button>)}</div></div>)}
    </section>
    {draft.body && <section className="contribution-result" aria-label="AI 整理结果">
      {!ready && !draft.submitted && <p className="muted small">上次的整理结果（本次尚未完成）</p>}
      <h2>{draft.title}</h2>
      <p className="repository-reference">仓库链接：{repoUrl ? <a href={repoUrl} onClick={e => { e.preventDefault(); void run(() => api.call('open.link', repoUrl)); }}>{repoUrl}</a> : <span className="muted">材料中未识别到，请在下方补充。</span>}</p>
      <div className={'generated-preview markdown ' + (!expanded && draft.body.length > 800 ? 'collapsed' : '')} aria-label="AI 整理说明"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:/.test(href)) void run(() => api.call('open.link', href)); }}>{children}</a>, img: ({ alt }) => <span>[图片：{alt || '附件'}]</span> }}>{draft.body}</ReactMarkdown></div>
      {draft.body.length > 800 && <button className="text-button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起详情' : '展开详情'}</button>}
    </section>}
    {(ready || draft.body) && !locked && <details className="repository-correction" open={showRepo} onToggle={e => setShowRepo(e.currentTarget.open)}><summary>{repoUrl ? '更正仓库链接（可选）' : '补充仓库链接'}</summary><label className="field">GitHub 仓库链接<input aria-label="GitHub 仓库链接" placeholder={draft.repoUrl || 'https://github.com/owner/repository'} value={value.repoUrlOverride} onChange={e => change({ repoUrlOverride: e.target.value })}/><small>AI 从材料中自动提取；缺失或不准确时可在这里补充、更正。</small></label></details>}
    <label className="field contribution-supplement">补充说明（可选）<textarea rows={3} aria-label="补充说明（可选）" placeholder="补充背景、注意事项或更正说明，也可以留空。" disabled={locked} value={value.supplement} onChange={e => change({ supplement: e.target.value })}/></label>
    {!locked && <div className="row small muted" role="status"><span>{editor.status}</span>{editor.status.startsWith('保存失败') && <button className="text-button" onClick={editor.retry}>重试保存</button>}</div>}
    <div className="automatic-destination" aria-label="自动上传位置"><b>上传至</b><div>{draft.binding ? <><span>{draft.binding.project.name}</span><code>{generating ? '正在自动识别……' : draft.target || draft.binding.project.uploadPath}</code><small>{!generating && (draft.destinationNote || '使用当前成员的默认成果目录。')}</small></> : <span>此会话未绑定共享项目，无法上传。</span>}</div><span className="badge">自动识别</span></div>
    <p className="muted small">上传仓库链接、AI 整理说明和你的补充。参考文件、代码和会话轨迹不在此次上传中。</p>
    <div className="draft-actions">{!draft.submitted && !submitted ? <><span className="muted small">{generating ? '整理完成后即可确认上传' : !repoUrl && ready ? '补充仓库链接后即可上传' : '点击确认后才会上传'}</span><span className="spacer"/><button className="primary" disabled={busy || !ready || !draft.body.trim() || !repoUrl || !draft.binding} onClick={() => void run(async () => { setBusy(true); try { await editor.flush(); await api.call('draft.submit', { id: draft.id }); setSubmitted(true); notice('成果已加入上传队列，可在传输记录中查看结果'); } finally { setBusy(false); } })}><Upload size={15}/>{busy ? '正在提交…' : '确认上传'}</button></> : <div className="green row"><Check size={17}/>成果已固化。查看传输记录确认上传状态或重试。</div>}</div>
  </div>;
}
