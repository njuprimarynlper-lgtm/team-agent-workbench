import React, { useState } from 'react';
import { Download, Upload, Check, Sparkles } from 'lucide-react';
import type { AgentSession, Draft } from '../shared/types';
import { useAutosave } from './autosave';
const api = window.workbench;
export function DraftEditor({ draft, session, run, notice }: { draft: Draft; session?: AgentSession; run: <T>(fn: () => Promise<T>) => Promise<T | undefined>; notice: (s: string) => void }) {
  const [busy, setBusy] = useState(false), [submitted, setSubmitted] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const generating = draft.generation === 'running';
  const locked = busy || submitted || !!draft.submitted;
  const editor = useAutosave('draft:' + draft.id, { title: draft.title, body: draft.body, repoUrl: draft.repoUrl || '', target: draft.target || draft.binding?.project.uploadPath || '' }, value => api.call('draft.save', { id: draft.id, ...value }));
  const value = editor.value;
  const change = (patch: Partial<typeof value>) => editor.change({ ...value, ...patch });
  return <div className="draft-editor">
    <section className="preparation-panel" aria-label="成果整理进度">
      <div className="row"><Sparkles size={19}/><b>1 · Agent 整理参考材料</b><span className="spacer"/>{generating && <span className="status-pulse"/>}</div>
      <p aria-live="polite" aria-label="整理状态">{generating ? 'Agent 正在整理成果，你可以继续工作，也可以先填写下方内容。' : draft.generation === 'error' ? '整理失败。可以重试，或直接手工填写修改说明。' : draft.generation === 'canceled' ? '已停止整理，可以手工填写或重新整理。' : draft.generatedBody ? '草稿已生成。预览后填入修改说明，再编辑确认。' : '填写下方仓库链接和修改说明。'}</p>
      {draft.generationError && <div className="inline-error" role="alert">{draft.generationError}</div>}
      <p className="muted small">读取点击整理时的交接文件和参考资料快照。只上传你确认的仓库链接与修改说明。</p>
      {draft.generatedBody && <details className="generated-preview" open><summary>{draft.generation === 'ready' ? '查看 Agent 草稿' : '上次生成的草稿（本次尚未成功）'}</summary><pre>{draft.generatedBody}</pre></details>}
      {!locked && <div className="row">{generating ? <button className="secondary compact" onClick={() => void run(() => api.call('draft.cancel', { id: draft.id }))}>停止整理</button> : <button className="secondary compact" onClick={() => void run(() => api.call('draft.retry', { id: draft.id }))}>{draft.generation === 'error' ? '重试整理' : '重新整理'}</button>}{draft.generatedBody && <button className="primary compact" onClick={() => change({ body: draft.generatedBody! })}>采用草稿作为修改说明</button>}</div>}
      {session?.approvals.map(a => <div className="approval" key={a.id}><strong>{a.title}</strong><details><summary>查看请求详情</summary><pre>{a.details}</pre></details>{a.questions?.map(q => <label className="field" key={q.id}>{q.text}{a.method === 'cursor/ask_question' ? <select value={answers[q.id] || ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })}><option value="">选择答案</option>{q.options.map(o => <option key={o}>{o}</option>)}</select> : <input value={answers[q.id] || ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })}/>}</label>)}<div className="row">{a.options.map(o => <button key={o.id} className={o.kind === 'deny' ? 'secondary' : 'primary'} onClick={() => void run(() => api.call('session.answer', { id: session.id, requestId: a.id, option: o.id, answers }))}>{o.label}</button>)}</div></div>)}
    </section>
    <h3>2 · 编辑要分享的内容</h3>
    <label className="field">成果标题<input aria-label="成果标题" disabled={locked} value={value.title} onChange={e => change({ title: e.target.value })}/></label>
    <label className="field">GitHub 仓库链接<input aria-label="GitHub 仓库链接" placeholder="https://github.com/owner/repository" disabled={locked} value={value.repoUrl} onChange={e => change({ repoUrl: e.target.value })}/><small>仓库本身的访问权限由 GitHub 管理；如需定位版本，可在说明中写分支、commit 或 PR 链接。</small></label>
    <div className="row gap-bottom"><b>修改说明</b></div>
    <textarea className="editor draft-body" aria-label="成果正文" placeholder="改了什么、为什么改、验证结果与尚未完成的部分。" disabled={locked} value={value.body} onChange={e => change({ body: e.target.value })}/>
    <h3>3 · 确认上传位置</h3>
    <label className="field">上传目标目录<input aria-label="上传目标目录" disabled={locked || !draft.binding} value={value.target} onChange={e => change({ target: e.target.value })}/></label>
    <p className="muted small">{draft.binding ? `${draft.binding.project.name} · ${draft.binding.username}@${draft.binding.host}` : '此草稿来源于本地会话'} · 本地整理参考 {draft.files.length} 项；不上传参考文件、交接文件或完整会话。</p>
    <div className="row" role="status"><span>{editor.status}</span>{editor.status.startsWith('保存失败') && <button className="text-button" onClick={editor.retry}>重试保存</button>}</div>
    <div className="draft-actions">{!draft.submitted && !submitted ? <><button className="secondary" disabled={busy} onClick={() => void run(async () => { editor.retry(); await editor.flush(); notice('草稿已保存'); })}>保存草稿</button><button className="secondary" disabled={busy} onClick={() => void run(async () => { await editor.flush(); await api.call('draft.export', { id: draft.id }); })}><Download size={15}/>导出成果包</button><span className="spacer"/><button className="primary" disabled={busy || !value.body.trim() || !value.repoUrl.trim() || !draft.binding} onClick={() => void run(async () => { setBusy(true); try { await editor.flush(); await api.call('draft.submit', { id: draft.id, target: value.target }); setSubmitted(true); notice('链接与修改说明已固化并加入上传队列'); } finally { setBusy(false); } })}><Upload size={15}/>{busy ? '正在提交…' : '确认并上传成果'}</button></> : <div className="green row"><Check size={17}/>成果已固化。查看传输记录确认上传状态或重试。</div>}</div>
  </div>;
}
