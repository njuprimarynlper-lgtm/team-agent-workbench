import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { ConnectionProfile, Project, WorkspaceAccess } from '../shared/types';
import { briefFields, PROJECT_BRIEF_FILE, projectBriefSchema, projectSetupIdentity, type ProjectBrief } from '../shared/project-brief';

export function ProjectOnboarding({ profile, workspace, close, created }: { profile: ConnectionProfile; workspace: WorkspaceAccess; close: () => void; created: (p: Project) => Promise<void> }) {
  const contextKey = projectSetupIdentity(profile, workspace.groupName!);
  const storageKey = 'project-onboarding:' + contextKey;
  const [form, setForm] = useState(() => {
    const blank = { name: '', brief: Object.fromEntries(briefFields.map(f => [f.key, ''])) as ProjectBrief };
    try { const saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); if (saved && typeof saved.name === 'string' && saved.name.length <= 180 && briefFields.every(f => typeof saved.brief?.[f.key] === 'string' && saved.brief[f.key].length <= 6000)) return saved as typeof blank; } catch { /* Keep a fresh form if local draft data is unavailable. */ }
    return blank;
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [draftError, setDraftError] = useState('');
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(form)); setDraftError(''); } catch { setDraftError('本机暂存失败，请保留当前窗口，填写内容仍可提交。'); } }, [form, storageKey]);
  const requiredReady = form.name.trim() && briefFields.filter(f => f.required).every(f => form.brief[f.key].trim());
  const unavailable = !workspace.canCreateProject || !!workspace.accessError;
  return <div className="modal-backdrop"><section className="modal wide project-onboarding" role="dialog" aria-label="完善项目资料"><header><h2>建立第一个项目</h2><button className="icon" aria-label="稍后填写项目资料" disabled={busy} onClick={close}><X size={19}/></button></header>
    <div className="modal-body"><div className="callout"><div><b>{workspace.groupLabel || workspace.groupName} · 项目初始化</b><small>{unavailable ? '工作组权限已变化，请关闭引导后查看最新工作组状态。填写内容仍保留在本机。' : '这个工作组还是空的，你是本组的项目子管理员。先说明团队要解决什么问题、做到什么程度，成员便能围绕同一目标开展工作。'}</small><small>账号：{profile.username} · 共享区：{profile.name} · {workspace.canonicalPath}</small></div></div>
      <p className="muted small">带 * 的内容必填；暂未确定的事项可注明待确认。填写内容先在本机暂存，点击保存后才写入共享项目。也可以稍后填写，返回工作组页面。</p>
      {error && <div className="inline-error" role="alert">{error}</div>}{draftError && <p className="inline-error">{draftError}</p>}
      <label className="field">项目名称 *<input disabled={busy} aria-label="引导项目名称" maxLength={180} placeholder="例如 客户信息抽取、OCR 质量提升、内部工具迭代" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}/></label>
      <div className="project-brief-fields">{briefFields.filter(f => f.required).map(field => <label className="field" key={field.key}>{field.label} *<textarea disabled={busy} aria-label={field.label} rows={3} maxLength={6000} placeholder={field.placeholder} value={form.brief[field.key]} onChange={e => setForm({ ...form, brief: { ...form.brief, [field.key]: e.target.value } })}/></label>)}</div>
      <details className="project-brief-optional"><summary>补充范围、资料与协作约定（可选）</summary>{briefFields.filter(f => !f.required).map(field => <label className="field" key={field.key}>{field.label}<textarea disabled={busy} aria-label={field.label} rows={3} maxLength={6000} placeholder={field.placeholder} value={form.brief[field.key]} onChange={e => setForm({ ...form, brief: { ...form.brief, [field.key]: e.target.value } })}/></label>)}</details>
      <p className="muted small">保存后自动创建项目、成果和轨迹目录，并生成《{PROJECT_BRIEF_FILE}》。本组成员可在共享文件区阅读，也可将说明加入自己的 Agent 会话。</p>
    </div><footer><button className="secondary" disabled={busy} onClick={close}>稍后填写</button><button className="primary" disabled={busy || !requiredReady || unavailable} onClick={async () => { setBusy(true); setError(''); try { const brief = projectBriefSchema.parse(form.brief); const project = await window.workbench.call<Project>('project.initialize', { name: form.name, groupName: workspace.groupName, brief, contextKey }); try { localStorage.removeItem(storageKey); } catch { /* A successful shared save is not reversed by a local storage error. */ } await created(project); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>{busy ? '正在创建并保存…' : '保存并创建项目'}</button></footer>
  </section></div>;
}
