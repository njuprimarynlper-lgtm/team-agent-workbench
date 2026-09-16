import React, { useState } from 'react';
import { Download, Upload, Check, Sparkles } from 'lucide-react';
import type { AgentSession, Draft } from '../shared/types';
import { useAutosave } from './autosave';
const api = window.workbench;
export function DraftEditor({ draft, session, run, notice, onSession }: { draft: Draft; session?: AgentSession; run: <T>(fn: () => Promise<T>) => Promise<T | undefined>; notice: (s: string) => void; onSession: (s: AgentSession) => void }) {
  const [busy, setBusy] = useState(false), [submitted, setSubmitted] = useState(false);
  const locked = busy || submitted || !!draft.submitted;
  const editor = useAutosave('draft:' + draft.id, { title: draft.title, body: draft.body, repoUrl: draft.repoUrl || '', target: draft.target || draft.binding?.project.uploadPath || '' }, value => api.call('draft.save', { id: draft.id, ...value }));
  const value = editor.value;
  const change = (patch: Partial<typeof value>) => editor.change({ ...value, ...patch });
  return <div className="draft-editor">
    <div className="callout"><Sparkles size={20}/><div>{session && ['running', 'starting'].includes(session.status) ? '独立会话正在整理，你可以继续原来的工作。' : draft.generatedBody ? 'AI 草稿已生成，检查后采用并编辑。' : '填写仓库链接和修改说明，也可进入整理会话查看进度。'}<small>只上传 GitHub 仓库链接和你确认的修改说明。参考文件留在本地，不随成果上传。</small></div>{session && <button className="secondary compact" onClick={() => onSession(session)}>查看整理会话</button>}</div>
    <label className="field">成果标题<input aria-label="成果标题" disabled={locked} value={value.title} onChange={e => change({ title: e.target.value })}/></label>
    <label className="field">GitHub 仓库链接<input aria-label="GitHub 仓库链接" placeholder="https://github.com/owner/repository" disabled={locked} value={value.repoUrl} onChange={e => change({ repoUrl: e.target.value })}/><small>仓库本身的访问权限由 GitHub 管理；如需定位版本，可在说明中写分支、commit 或 PR 链接。</small></label>
    <div className="row gap-bottom"><b>修改说明</b><span className="spacer"/>{draft.generatedBody && !draft.submitted && <button className="secondary compact" disabled={locked} onClick={() => change({ body: draft.generatedBody! })}>用 AI 草稿替换正文</button>}</div>
    <textarea className="editor draft-body" aria-label="成果正文" placeholder="改了什么、为什么改、验证结果与尚未完成的部分。" disabled={locked} value={value.body} onChange={e => change({ body: e.target.value })}/>
    <label className="field">上传目标目录<input aria-label="上传目标目录" disabled={locked || !draft.binding} value={value.target} onChange={e => change({ target: e.target.value })}/></label>
    <p className="muted small">{draft.binding ? `${draft.binding.project.name} · ${draft.binding.username}@${draft.binding.host}` : '此草稿来源于本地会话'} · 本地整理参考 {draft.files.length} 项；不上传参考文件、交接文件或完整会话。</p>
    <div className="row" role="status"><span>{editor.status}</span>{editor.status.startsWith('保存失败') && <button className="text-button" onClick={editor.retry}>重试保存</button>}</div>
    <div className="draft-actions">{!draft.submitted && !submitted ? <><button className="secondary" disabled={busy} onClick={() => void run(async () => { editor.retry(); await editor.flush(); notice('草稿已保存'); })}>保存草稿</button><button className="secondary" disabled={busy} onClick={() => void run(async () => { await editor.flush(); await api.call('draft.export', { id: draft.id }); })}><Download size={15}/>导出成果包</button><span className="spacer"/><button className="primary" disabled={busy || !value.body.trim() || !value.repoUrl.trim() || !draft.binding} onClick={() => void run(async () => { setBusy(true); try { await editor.flush(); await api.call('draft.submit', { id: draft.id, target: value.target }); setSubmitted(true); notice('链接与修改说明已固化并加入上传队列'); } finally { setBusy(false); } })}><Upload size={15}/>{busy ? '正在提交…' : '确认并上传成果'}</button></> : <div className="green row"><Check size={17}/>成果已固化。查看传输记录确认上传状态或重试。</div>}</div>
  </div>;
}
