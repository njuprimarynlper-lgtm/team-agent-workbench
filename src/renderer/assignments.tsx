import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ClipboardList, Plus, RefreshCw } from 'lucide-react';
import { assignmentStatuses, type AssignmentMember, type AssignmentStatus, type ProjectAssignment } from '../shared/assignments';
import type { AgentSession, Project } from '../shared/types';
import type { SharedContent } from '../shared/content';
import { contentAliasKey, titleSubject } from '../shared/content';
import { rankConclusions } from '../core/conclusion-matcher';

const api = window.workbench;
export function AssignmentsPanel({ project, admin, username, items, loading, loadError, refresh, start, sessions, aliases }: {
  project: Project; admin: boolean; username: string; items: ProjectAssignment[]; loading: boolean; loadError: string;
  refresh: () => Promise<void>; start: (task: ProjectAssignment) => void; sessions: AgentSession[]; aliases: Record<string, string>;
}) {
  const [selected, setSelected] = useState(''), [scope, setScope] = useState<'active' | 'all'>('active');
  const [creating, setCreating] = useState(false), [requestId, setRequestId] = useState(''), [title, setTitle] = useState(''), [description, setDescription] = useState(''), [acceptance, setAcceptance] = useState(''), [assignee, setAssignee] = useState('');
  const [members, setMembers] = useState<AssignmentMember[]>([]), [content, setContent] = useState<SharedContent[]>([]), [referenceIds, setReferenceIds] = useState<string[]>([]), [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmStatus, setConfirmStatus] = useState<{ task: ProjectAssignment; status: 'completed' | 'cancelled' }>();
  const displayTitle = (item: SharedContent) => aliases[contentAliasKey(project.id, item.id)] || titleSubject(item.title) || item.title;
  const ranked = useMemo(() => rankConclusions(content.map(item => ({ id: item.id, projectId: project.id, title: item.title, titleAlias: aliases[contentAliasKey(project.id, item.id)], content: item.description, sources: [], version: item.revision, updatedAt: item.updatedAt })), `${title}\n${description}`, 8), [content, title, description, project.id, aliases]);
  const recommended = new Map(ranked.map((item, index) => [item.conclusion.id, { index, reasons: item.reasons.join('；') }]));
  const candidates = content.filter(item => `${displayTitle(item)} ${item.title} ${item.description} ${item.author}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a, b) => (recommended.get(a.id)?.index ?? 999) - (recommended.get(b.id)?.index ?? 999));
  const visible = items.filter(task => scope === 'all' || ['assigned', 'in_progress'].includes(task.status));
  const task = visible.find(item => item.id === selected) || visible[0];
  const localSession = (value: ProjectAssignment) => sessions.find(session => session.assignment?.id === value.id && !session.closedAt);
  const beginCreate = async () => {
    setBusy(true); setError('');
    try {
      const [people, results] = await Promise.all([api.call<AssignmentMember[]>('assignment.members', { projectId: project.id }), api.call<SharedContent[]>('content.list', { projectId: project.id })]);
      setMembers(people); setContent(results.filter(item => item.kind === 'contribution')); setRequestId(crypto.randomUUID()); setTitle(''); setDescription(''); setAcceptance(''); setAssignee(''); setReferenceIds([]); setSearch(''); setCreating(true);
    } catch (error: any) { setError(error.message); } finally { setBusy(false); }
  };
  const reloadChoices = async () => {
    setBusy(true); setError('');
    try {
      const [people, results] = await Promise.all([api.call<AssignmentMember[]>('assignment.members', { projectId: project.id }), api.call<SharedContent[]>('content.list', { projectId: project.id })]);
      setMembers(people); setContent(results.filter(item => item.kind === 'contribution')); setReferenceIds([]); setRequestId(crypto.randomUUID()); if (!people.some(item => item.username === assignee)) setAssignee('');
    } catch (error: any) { setError(error.message); } finally { setBusy(false); }
  };
  const create = async () => {
    setBusy(true); setError('');
    try {
      const saved = await api.call<ProjectAssignment>('assignment.create', { projectId: project.id, task: { id: requestId, title, description, acceptance, assignee, references: content.filter(item => referenceIds.includes(item.id)).map(({ id, revision }) => ({ id, revision })) } });
      setSelected(saved.id); setScope('active'); setCreating(false); await refresh();
    } catch (error: any) { setError(error.message); } finally { setBusy(false); }
  };
  const updateStatus = async () => {
    if (!confirmStatus) return; setBusy(true); setError('');
    try {
      const { task, status } = confirmStatus;
      await api.call('assignment.status', { projectId: project.id, change: { id: task.id, revision: task.revision, status } });
      setConfirmStatus(undefined); await refresh();
    } catch (error: any) { setError(error.message); } finally { setBusy(false); }
  };
  return <div className="workspace-page assignments-page">
    <div className="page-title"><div><span className="eyebrow">PROJECT TASKS</span><h1>{admin ? '项目派活' : '我的任务'} · {project.name}</h1><p className="muted small">{admin ? '把任务交给指定成员，并配上帮助他开始工作的共享结论。' : '查看分配给你的任务，带着任务说明和关联结论开始工作。'}</p></div><div className="row"><button className="secondary" disabled={busy || loading} onClick={() => void refresh()}><RefreshCw size={14}/>刷新任务</button>{admin && <button className="primary" disabled={busy} onClick={() => void beginCreate()}><Plus size={14}/>派发任务</button>}</div></div>
    {(loadError || error && !creating && !confirmStatus) && <div className="inline-error" role="alert">{loadError || error}</div>}
    <div className="updates-scope" role="tablist" aria-label="任务范围"><button role="tab" aria-selected={scope === 'active'} onClick={() => setScope('active')}>待办任务 {items.filter(item => ['assigned', 'in_progress'].includes(item.status)).length}</button><button role="tab" aria-selected={scope === 'all'} onClick={() => setScope('all')}>全部任务 {items.length}</button></div>
    {loading && !items.length && <p role="status">正在读取任务…</p>}
    <div className="content-library assignment-library"><div className="content-cards">{visible.map(item => <article key={item.id} className={'content-card ' + (task?.id === item.id ? 'selected' : '')}><button className="content-card-summary" onClick={() => setSelected(item.id)}><span className={'badge ' + (item.status === 'completed' ? 'done' : item.status === 'in_progress' ? 'running' : '')}>{assignmentStatuses[item.status]}</span><b>{item.title}</b><small>负责人：{item.assigneeName} · 派发人：{item.createdBy}</small><p>{item.description.slice(0, 120)}</p><small>{item.references.length} 条关联结论 · {new Date(item.createdAt).toLocaleString()}</small></button></article>)}{!visible.length && !loading && <div className="page-empty"><ClipboardList size={36}/><h2>{admin ? '还没有待办任务' : '暂无分配给你的任务'}</h2><p>{admin ? '点击“派发任务”，选择成员并说明工作要求。' : '子管理员派发后会显示在这里，你也可以自行新建工作会话。'}</p></div>}</div>
      <section className="content-detail assignment-detail">{task ? <><span className="content-category-badge">{assignmentStatuses[task.status]}</span><h2>{task.title}</h2><p className="muted small">负责人：{task.assigneeName}（{task.assignee}） · 派发人：{task.createdBy}</p><h3>任务目标与工作范围</h3><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{task.description}</ReactMarkdown></div><h3>验收要求</h3><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{task.acceptance || '尚未填写，可与派发人确认。'}</ReactMarkdown></div><h3>关联结论（{task.references.length}）</h3><p className="muted small">以下保留派发时的内容版本。开始工作时，会带入会话并保存到“我的项目笔记”。</p><div className="assignment-references">{task.references.map(reference => <details key={reference.id}><summary>{titleSubject(reference.title) || reference.title} <small>v{reference.revision} · {reference.author}</small></summary><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{reference.content}</ReactMarkdown></div></details>)}</div>{!task.references.length && <p className="muted small">派发人未附关联结论。</p>}<div className="row assignment-actions">{task.assignee === username && ['assigned', 'in_progress'].includes(task.status) && <button className="primary" disabled={busy} onClick={() => start(task)}>{localSession(task) ? '继续工作' : '开始工作'}</button>}{task.assignee === username && task.status === 'in_progress' && <button className="secondary" disabled={busy} onClick={() => { setError(''); setConfirmStatus({ task, status: 'completed' }); }}>标记完成</button>}{admin && ['assigned', 'in_progress'].includes(task.status) && <button className="secondary danger" disabled={busy} onClick={() => { setError(''); setConfirmStatus({ task, status: 'cancelled' }); }}>取消任务</button>}</div></> : <p className="muted">选择任务查看详情。</p>}</section>
    </div>
    {creating && <div className="modal-backdrop"><section className="modal wide assignment-create-modal" role="dialog" aria-modal="true" aria-labelledby="assignment-create-title"><header><h2 id="assignment-create-title">派发任务</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={() => setCreating(false)}>×</button></header><div className="modal-body">
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="form-grid"><label className="field">负责人<select aria-label="任务负责人" disabled={busy} value={assignee} onChange={event => setAssignee(event.target.value)}><option value="">请选择本组成员</option>{members.map(item => <option value={item.username} key={item.username}>{item.name}（{item.username}）</option>)}</select></label><label className="field">任务标题<input aria-label="任务标题" maxLength={200} value={title} onChange={event => setTitle(event.target.value)}/></label></div>
      <label className="field">任务目标与工作范围<textarea aria-label="任务目标与工作范围" rows={4} maxLength={12000} placeholder="说明需要完成什么、从哪里开始、有哪些约束。" value={description} onChange={event => setDescription(event.target.value)}/></label><label className="field">验收要求（可选）<textarea aria-label="任务验收要求" rows={2} maxLength={6000} value={acceptance} onChange={event => setAcceptance(event.target.value)} placeholder="例如：提交验证结果，说明样本覆盖及未解决问题。"/></label>
      <div className="row"><h3>关联共享结论（已选 {referenceIds.length}/20）</h3><span className="spacer"/><button className="text-button" disabled={busy} onClick={() => void reloadChoices()}>刷新成员和结论</button></div><p className="muted small">填写任务后，会优先显示文字相关的候选结论；勾选的内容将随任务交给成员。刷新会清空勾选，便于重新核对版本。</p><input aria-label="搜索任务关联结论" placeholder="搜索结论名称、内容或作者" value={search} onChange={event => setSearch(event.target.value)}/>
      <div className="assignment-choices">{candidates.map(item => <div className="assignment-choice" key={item.id}><label className="check-row"><input type="checkbox" aria-label={`关联结论：${displayTitle(item)}`} checked={referenceIds.includes(item.id)} disabled={busy || !referenceIds.includes(item.id) && referenceIds.length >= 20} onChange={event => setReferenceIds(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))}/><span><b>{displayTitle(item)}</b><small>v{item.revision} · {item.author}{recommended.has(item.id) ? ' · 与任务相关：' + recommended.get(item.id)!.reasons : ''}</small></span></label><details><summary>阅读结论</summary><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.description}</ReactMarkdown></div></details></div>)}</div>{!candidates.length && <p className="muted small">暂无匹配的共享结论，可以先派发任务。</p>}
    </div><footer><button className="secondary" disabled={busy} onClick={() => setCreating(false)}>取消</button><button className="primary" disabled={busy || !assignee || !title.trim() || !description.trim()} onClick={() => void create()}>{busy ? '正在派发…' : '确认派发'}</button></footer></section></div>}
    {confirmStatus && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="assignment-status-title"><header><h2 id="assignment-status-title">{confirmStatus.status === 'completed' ? '确认完成任务？' : '确认取消任务？'}</h2></header><div className="modal-body"><p>{confirmStatus.task.title}</p><p className="muted small">{confirmStatus.status === 'completed' ? '确认已达到任务要求后，派发人将看到“已完成”。' : '负责人会看到“已取消”，此任务将不能再创建工作会话。'}已有会话和项目笔记会保留。</p>{error && <div className="inline-error" role="alert">{error}</div>}</div><footer><button className="secondary" disabled={busy} onClick={() => setConfirmStatus(undefined)}>返回</button><button className="primary" disabled={busy} onClick={() => void updateStatus()}>确认{confirmStatus.status === 'completed' ? '完成' : '取消任务'}</button></footer></section></div>}
  </div>;
}
