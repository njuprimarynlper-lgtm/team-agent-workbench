import { MenuDetails } from './menu-details';
import React, { useEffect, useState } from 'react';
import { Folder, FolderPlus, Ellipsis, Pencil, ArrowRight, X, Layers, FolderInput, Trash2 } from 'lucide-react';
import type { AgentSession, Project } from '../shared/types';
import type { PersonalGroup } from '../shared/personal-workspace';
import { isPersonalBinding, PERSONAL_PROJECT_ID } from '../shared/personal-workspace';
import { canFollowProjectDirectory, followsProjectDirectory } from '../shared/project-directory';

export function SessionDirectorySettings({ session, call, changed }: { session: AgentSession; call: Call; changed: () => Promise<void> }) {
  const [current, setCurrent] = useState(session), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => setCurrent(session), [session]);
  return <section aria-label="会话工作目录"><label className="field">工作目录<select aria-label="会话目录模式" disabled={busy || !canFollowProjectDirectory(current)} value={followsProjectDirectory(current) ? 'project' : 'fixed'} onChange={async event => {
    const mode = event.target.value; setBusy(true); setError('');
    try { setCurrent(await call<AgentSession>('session.directory.mode', { id: current.id, mode })); await changed(); }
    catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
  }}><option value="project">跟随项目目录</option><option value="fixed">保留当前独立目录</option></select></label><p className="muted small">共用目录的父子会话一起调整；独立分支不受影响。</p><p className="muted small break">当前目录：{current.cwd}</p>{current.directoryMove && <p className="muted small break" role="status">待切换到：{current.directoryMove.to}<br/>{current.directoryMove.error ? '迁移尚未完成：' + current.directoryMove.error + '。可在对话输入框上方重试，或选择保留当前独立目录。' : '当前任务结束后自动切换。'}</p>}{!!current.directoryChange?.conflicts.length && <details><summary>迁移时保留的同名副本</summary>{current.directoryChange.conflicts.map(file => <p className="muted small break" key={file}>{file}</p>)}</details>}{!canFollowProjectDirectory(current) && <p className="muted small">此会话的目录由独立分支或外部客户端管理。</p>}{error && <p className="inline-error" role="alert">{error}</p>}</section>;
}

type Call = <T = unknown>(action: string, payload?: unknown) => Promise<T>;
export type MoveSelection = { sessionId?: string; groupId?: string; title: string; count: number };

export function PersonalSection({ groups, sessions, active, selected, select, move, call, changed, children }: {
  groups: PersonalGroup[]; sessions: AgentSession[]; active: boolean; selected: string;
  select: (id: string) => void; move: (selection: MoveSelection) => void; call: Call; changed: () => Promise<void>;
  children?: React.ReactNode;
}) {
  const [editing, setEditing] = useState<{ id?: string; name: string }>(), [removing, setRemoving] = useState<PersonalGroup>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const openSessions = sessions.filter(session => session.purpose === 'work' && !session.closedAt);
  const openCount = (id: string) => openSessions.filter(session => (session.personalGroupId || '') === id).length;
  // Whole-group moves also preserve closed conversations and their records.
  const count = (id: string) => sessions.filter(session => (session.personalGroupId || '') === id).length;
  const close = () => { if (!busy) { setEditing(undefined); setRemoving(undefined); setError(''); } };
  const submit = async () => {
    setBusy(true); setError('');
    try {
      if (removing) { await call('local.group.delete', { id: removing.id }); if (selected === removing.id) select(''); }
      else if (editing) { const group = await call<PersonalGroup>('local.group.save', editing); select(group.id); }
      await changed(); setEditing(undefined); setRemoving(undefined);
    } catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
  };
  return <section className={'personal-section ' + (active ? 'is-active' : '')} aria-label="未分项目">
    <header><button className="personal-heading" onClick={() => select('*')}><Layers size={16}/><b>未分项目</b><span className="personal-count">{openSessions.length}</span></button><button className="icon" aria-label="新建个人分组" title="新建个人分组" onClick={() => { setError(''); setEditing({ name: '' }); }}><FolderPlus size={15}/></button></header>
    <div className="personal-group-row"><button className={'personal-group ' + (active && selected === '' ? 'selected' : '')} onClick={() => select('')}><Folder size={14}/><span>未分组</span><small>{openCount('')}</small></button></div>
    {groups.map(group => <div className="personal-group-row" key={group.id}><button className={'personal-group ' + (active && selected === group.id ? 'selected' : '')} onClick={() => select(group.id)}><Folder size={14}/><span>{group.name}</span><small>{openCount(group.id)}</small></button><MenuDetails className="personal-menu" onToggle={event => { const menu = event.currentTarget; if (!menu.open) return; const rect = menu.getBoundingClientRect(), popup = menu.querySelector('div')!; popup.style.top = Math.min(rect.bottom + 4, window.innerHeight - 140) + 'px'; popup.style.left = Math.max(8, rect.right - 205) + 'px'; }}><summary role="button" aria-haspopup="menu" aria-label={'管理个人分组 ' + group.name} title="分组操作"><Ellipsis size={15}/></summary><div role="menu"><button role="menuitem" onClick={event => { event.currentTarget.closest('details')!.open = false; setError(''); setEditing(group); }}><Pencil size={14}/>重命名</button><button role="menuitem" disabled={!count(group.id)} onClick={event => { event.currentTarget.closest('details')!.open = false; move({ groupId: group.id, title: group.name, count: count(group.id) }); }}><FolderInput size={14}/>整组迁移到项目</button><button role="menuitem" onClick={event => { event.currentTarget.closest('details')!.open = false; setError(''); setRemoving(group); }}><Trash2 size={14}/>解散分组</button></div></MenuDetails></div>)}
    {(editing || removing) && <div className="modal-backdrop"><section className="modal personal-dialog"><header><h2>{removing ? '解散个人分组' : editing?.id ? '重命名个人分组' : '新建个人分组'}</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}><X size={18}/></button></header><form onSubmit={event => { event.preventDefault(); void submit(); }}><div className="modal-body">{removing ? <p>解散“{removing.name}”后，里面的会话会回到“未分组”，会话内容保留。</p> : <label className="field">分组名称<input aria-label="个人分组名称" autoFocus maxLength={60} value={editing?.name || ''} onChange={event => setEditing({ ...editing, name: event.target.value })} placeholder="例如：日常开发、资料研究"/></label>}{error && <div className="inline-error" role="alert">{error}</div>}</div><footer><button type="button" className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || !removing && !editing?.name.trim()}>{busy ? '正在保存…' : removing ? '解散分组' : '保存分组'}</button></footer></form></section></div>}
    {active && children}
  </section>;
}

export function SessionOrganization({ session, groups, close, move, call, changed }: { session: AgentSession; groups: PersonalGroup[]; close: () => void; move: (selection: MoveSelection) => void; call: Call; changed: () => Promise<void> }) {
  const [groupId, setGroupId] = useState(session.personalGroupId || ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const unassigned = isPersonalBinding(session.binding) && session.binding?.project.id === PERSONAL_PROJECT_ID;
  return <div className="modal-backdrop"><section className="modal personal-dialog"><header><h2>管理会话归属</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}><X size={18}/></button></header><div className="modal-body"><p className="muted small">{session.title}</p>{unassigned ? <label className="field">个人分组<select aria-label="会话个人分组" value={groupId} onChange={event => setGroupId(event.target.value)}><option value="">未分组</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label> : <p className="muted small">当前项目：{session.binding?.project.name}</p>}<SessionDirectorySettings session={session} call={call} changed={changed}/><button className="personal-move-link" disabled={busy} onClick={() => move({ sessionId: session.id, title: session.title, count: 1 })}><FolderInput size={17}/><span>迁移到项目<small>保留完整会话，迁移后从原位置移除</small></span><ArrowRight size={15}/></button>{error && <div className="inline-error" role="alert">{error}</div>}</div><footer><button className="secondary" disabled={busy} onClick={close}>取消</button>{unassigned && <button className="primary" disabled={busy || groupId === (session.personalGroupId || '')} onClick={async () => { setBusy(true); try { await call('local.session.group', { id: session.id, groupId: groupId || undefined }); await changed(); close(); } catch (reason: any) { setError(reason.message); } finally { setBusy(false); } }}>保存分组</button>}</footer></section></div>;
}

export function PersonalMoveDialog({ selection, projects, connected, connect, call, close, moved }: {
  selection: MoveSelection; projects: Project[]; connected: boolean; connect: () => void; call: Call; close: () => void;
  moved: (result: { count: number; projectId: string; sessionId: string }) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <div className="modal-backdrop"><section className="modal personal-dialog"><header><h2>{selection.groupId ? '整组迁移到项目' : '迁移到项目'}</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}><X size={18}/></button></header><div className="modal-body"><div className="personal-move-summary"><FolderInput size={23}/><div><b>{selection.title}</b><small>{selection.count} 条工作会话{selection.sessionId && selection.count > 1 ? '（包含关联父子会话）' : ''} · 历史、摘要、整理草稿和成果引用一起保留</small></div></div><label className="field">目标项目<select aria-label="迁移目标项目" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">请选择目标项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>{!projects.length && <small>暂无可迁入的项目，请先连接中央节点并创建项目。</small>}</label><p className="muted small">迁移完成后，原位置的会话{selection.groupId ? '和个人分组' : ''}会移除。跟随项目的会话会采用目标项目目录，复制校验后切换；独立目录保持原样。AI、网络方式和聊天历史保留。</p><p className="muted small">有对话、侧边提问、整理或上传正在运行时，请先结束后再迁移。原项目的提问自动关联会解除，已发布成果保留在原项目。</p>{error && <div className="inline-error" role="alert">{error}</div>}</div><footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || !projects.some(project => project.id === projectId)} onClick={async () => { setBusy(true); setError(''); try { const result = await call<{ count: number; projectId: string; sessionId: string }>('local.move', { sessionId: selection.sessionId, groupId: selection.groupId, projectId }); await moved(result); } catch (reason: any) { setError(reason.message); } finally { setBusy(false); } }}>{busy ? '正在整体迁移…' : `迁移 ${selection.count} 条会话`}</button></footer></section></div>;
}
