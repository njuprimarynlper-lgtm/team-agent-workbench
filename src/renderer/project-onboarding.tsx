import { collaborationFailure } from './collaboration-failure';
import { MarkdownEditor } from './markdown-editor';
import { uiErrorMessage } from '../shared/user-failure';
import { ErrorLogLink } from './error-notice';
import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { ConnectionProfile, Project, WorkspaceAccess } from '../shared/types';
import { briefFields, projectBriefSchema, projectSetupIdentity, type ProjectBrief } from '../shared/project-brief';

export function ProjectOnboarding({ profile, workspace, close, created }: { profile: ConnectionProfile; workspace: WorkspaceAccess; close: () => void; created: (p: Project) => Promise<void> }) {
  const contextKey = projectSetupIdentity(profile, workspace.groupName!);
  const storageKey = 'project-onboarding:' + contextKey;
  const [form, setForm] = useState(() => {
    const blank = { name: workspace.groupLabel || workspace.groupName!, brief: Object.fromEntries(briefFields.map(f => [f.key, ''])) as ProjectBrief };
    try { const saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); if (saved && typeof saved.name === 'string' && saved.name.length <= 180 && briefFields.every(f => typeof saved.brief?.[f.key] === 'string' && saved.brief[f.key].length <= 6000)) return { ...saved, name: blank.name } as typeof blank; } catch { /* Keep a fresh form if local draft data is unavailable. */ }
    return blank;
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [draftError, setDraftError] = useState('');
  const [confirmed, setConfirmed] = useState<Project>();
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(form)); setDraftError(''); } catch { setDraftError('本机暂存失败，请保留当前窗口，填写内容仍可提交。'); } }, [form, storageKey]);
  const requiredReady = form.name.trim() && briefFields.filter(f => f.required).every(f => form.brief[f.key].trim());
  const unavailable = !workspace.canCreateProject || !!workspace.accessError;
  const save = async () => {
    if (busy) return; setBusy(true); setError('');
    try {
      let project = confirmed;
      if (!project) {
        const brief = projectBriefSchema.parse(form.brief);
        project = await window.workbench.call<Project>('project.initialize', { name: form.name, groupName: workspace.groupName, brief, contextKey });
        setConfirmed(project); setDraftError('');
        try { localStorage.removeItem(storageKey); } catch { /* The project was confirmed independently of local draft cleanup. */ }
      }
      try { await created(project); }
      catch (reason) { setError(collaborationFailure(reason, `项目「${project.name}」已创建，项目列表没刷新出来。点“刷新项目并继续”即可，不用再创建。`, { domain: 'central', operation: '刷新已创建项目', outcome: 'accepted' })); }
    } catch (reason) { setError(uiErrorMessage(reason, { domain: 'central', operation: '创建项目并保存资料', outcome: 'unknown' })); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><section className="modal wide project-onboarding" role="dialog" aria-label="完善项目资料"><header><h2>完善项目资料</h2><button className="icon" aria-label="稍后填写项目资料" disabled={busy} onClick={close}><X size={19}/></button></header>
    <div className="modal-body"><div className="callout"><div><b>{workspace.groupLabel || workspace.groupName} · 项目初始化</b>{unavailable && <small>项目权限已变化，请关闭后刷新项目列表。</small>}<small>账号：{profile.username}</small></div></div>

      {error && <div className="inline-error" role="alert">{error} <ErrorLogLink message={error}/></div>}{draftError && <p className="inline-error">{draftError}</p>}
      {!confirmed && <><label className="field">项目名称 *<input readOnly aria-label="引导项目名称" maxLength={180} placeholder="例如 客户信息抽取、OCR 质量提升、内部工具迭代" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}/></label>
      <div className="project-brief-fields">{briefFields.filter(f => f.required).map(field => <label className="field" key={field.key}>{field.label} *<MarkdownEditor disabled={busy || !!confirmed} aria-label={field.label} rows={3} maxLength={6000} placeholder={field.placeholder} value={form.brief[field.key]} onChange={e => setForm({ ...form, brief: { ...form.brief, [field.key]: e.target.value } })}/></label>)}</div>
      <details className="project-brief-optional"><summary>补充范围、资料与协作约定（可选）</summary>{briefFields.filter(f => !f.required).map(field => <label className="field" key={field.key}>{field.label}<MarkdownEditor disabled={busy || !!confirmed} aria-label={field.label} rows={3} maxLength={6000} placeholder={field.placeholder} value={form.brief[field.key]} onChange={e => setForm({ ...form, brief: { ...form.brief, [field.key]: e.target.value } })}/></label>)}</details></>}

    </div><footer><button className="secondary" disabled={busy} onClick={close}>{confirmed ? '关闭' : '稍后填写'}</button><button className="primary" disabled={busy || !confirmed && (!requiredReady || unavailable)} onClick={() => void save()}>{busy ? confirmed ? '正在刷新项目…' : '正在创建并保存…' : confirmed ? '刷新项目并继续' : '保存项目资料'}</button></footer>
  </section></div>;
}
