import { errorMessage } from '../shared/errors';
import React, { useEffect, useRef, useState } from 'react';
import type { Project, ProjectBriefState } from '../shared/types';
import { briefFields, type ProjectBrief } from '../shared/project-brief';
import { projectCreateSchema } from '../shared/project-connection';

const blank = () => Object.fromEntries(briefFields.map(field => [field.key, ''])) as ProjectBrief;

function BriefFields({ brief, setBrief, busy, readOnly }: { brief: ProjectBrief; setBrief: React.Dispatch<React.SetStateAction<ProjectBrief>>; busy: boolean; readOnly: boolean }) {
  if (readOnly) {
    if (busy && briefFields.every(field => !brief[field.key].trim())) return <p className="muted">正在读取项目说明…</p>;
    const visible = briefFields.filter(field => field.required || brief[field.key].trim());
    if (!visible.length) return <p className="muted">项目说明尚未填写。</p>;
    return <>{visible.map(field => <section className="brief-reading" key={field.key} aria-label={field.label}><h3>{field.label}</h3><p>{brief[field.key].trim() || '尚未填写'}</p></section>)}</>;
  }
  return <>{briefFields.map(field => <label className="field" key={field.key}>{field.label}{field.required ? ' *' : '（可选）'}<textarea aria-label={field.label} rows={field.required ? 3 : 2} maxLength={6000} disabled={busy} value={brief[field.key]} placeholder={field.placeholder} onChange={event => { const value = event.target.value; setBrief(previous => ({ ...previous, [field.key]: value })); }}/></label>)}</>;
}

export function ProjectBriefSettings({ project, admin, cancel, saved, saveLabel = '保存新版本', localSettings }: { project: Project; admin: boolean; cancel?: () => void; saved: (revision: number) => Promise<void>; saveLabel?: string; localSettings?: React.ReactNode }) {
  const [brief, setBrief] = useState<ProjectBrief>(blank), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setBusy(true); setError(''); setBrief(blank()); setRevision(0);
    void window.workbench.call<ProjectBriefState>('project.brief', { projectId: project.id }).then(data => {
      if (active) { setBrief(data.brief || blank()); setRevision(data.revision); }
    }, reason => { if (active) setError(errorMessage(reason)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [project.id]);
  const invalid = briefFields.filter(field => field.required).some(field => !brief[field.key].trim());
  return <><div className="modal-body project-settings-form">
    {localSettings}
    <div className="callout"><span className="project-file-icon" aria-hidden="true">MD</span><div><b>{project.name}</b><small>{admin ? '下列字段与共享项目根目录中的“项目说明.md”一一对应；修改先保存在本机，连接后自动同步；冲突不会覆盖任一版本。' : '这是本项目当前的项目说明，对应共享目录中的“项目说明.md”，由创建者或管理者维护。'}</small></div></div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {!admin && <p className="muted small">只读，仅本项目创建者或管理者可修改。</p>}
    <BriefFields brief={brief} setBrief={setBrief} busy={busy} readOnly={!admin}/>
  </div><footer>{cancel && <button className="secondary" disabled={busy} onClick={cancel}>取消</button>}{admin && <button className="primary" disabled={busy || invalid} onClick={async () => {
    setBusy(true); setError('');
    try {
      const result = await window.workbench.call<ProjectBriefState & { briefRevision?: number }>('project.brief.save', { projectId: project.id, brief, revision });
      const nextRevision = result.revision ?? result.briefRevision ?? revision + 1;
      setRevision(nextRevision); await saved(nextRevision);
    } catch (reason: any) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }}>{busy ? '保存中…' : saveLabel}</button>}</footer></>;
}

export function ProjectBriefEditor({ project, initialName = '', connectionLabel, admin, close, saved }: { project?: Project; initialName?: string; connectionLabel?: string; admin: boolean; close: () => void; saved: (project?: Project) => Promise<void> }) {
  const [name, setName] = useState(initialName);
  const attempt = useRef<{ key: string; id: string } | undefined>(undefined);
  const [createdProject, setCreatedProject] = useState<Project>();
  const [brief, setBrief] = useState<ProjectBrief>(blank), [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (project) return <div className="modal-backdrop"><section className="modal wide" role="dialog" aria-label="项目资料"><header><h2>项目资料 · {project.name}</h2><button className="secondary compact" disabled={busy} onClick={close}>关闭</button></header><ProjectBriefSettings project={project} admin={admin} cancel={close} saved={async () => saved()}/></section></div>;
  const invalid = !projectCreateSchema.safeParse({ name, brief: skip ? undefined : brief }).success;
  const locked = busy || !!createdProject;
  return <div className="modal-backdrop"><section className="modal wide" role="dialog" aria-label="项目资料"><header><h2>创建项目{connectionLabel ? ' · 项目资料' : ''}</h2><button className="secondary compact" disabled={busy} onClick={close}>关闭</button></header><div className="modal-body">
    {connectionLabel && <p className="muted small">中央节点：{connectionLabel}</p>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    {createdProject && <p role="status">项目已创建，可继续打开。不会重复创建。</p>}
    <label className="field">项目名称<input aria-label="项目名称" maxLength={24} placeholder="24 字以内，支持中文、字母、数字及 _·-" disabled={locked} value={name} onChange={event => setName(event.target.value)}/></label>
    <p className="muted small">创建后，你是项目的创建者，可在项目设置中添加成员。</p>
    <label className="check-row"><input type="checkbox" disabled={locked} checked={skip} onChange={event => setSkip(event.target.checked)}/>先创建目录，稍后完善项目资料</label>
    {!skip && <BriefFields brief={brief} setBrief={setBrief} busy={locked} readOnly={!admin}/>}
  </div><footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || (!createdProject && invalid)} onClick={async () => {
    setBusy(true); setError('');
    try {
      if (createdProject) { await saved(createdProject); return; }
      const input = projectCreateSchema.parse({ name, brief: skip ? undefined : brief }), key = JSON.stringify(input);
      if (attempt.current?.key !== key) attempt.current = { key, id: 'project_' + crypto.randomUUID().replace(/-/g, '') };
      const result = await window.workbench.call<Project>('project.create', { ...input, requestId: attempt.current.id });
      setCreatedProject(result); await saved(result);
    } catch (reason: any) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }}>{busy ? '正在创建…' : createdProject ? '打开项目' : '创建项目'}</button></footer></section></div>;
}
