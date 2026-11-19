import { contextualError } from './contextual-error';
import { ErrorLogLink } from './error-notice';
import React, { useEffect, useRef, useState } from 'react';
import { Check, FolderOpen } from 'lucide-react';
import type { AgentSession, Project } from '../shared/types';
import type { GroupCommand } from '../shared/team-groups';
import { ProjectBriefSettings } from './project-brief-editor';
import { TeamGroupDialog } from './team-groups';
import { RsiProjectSettings } from './rsi-project-settings';
import { SyncConflictCard } from './account-sync';
import type { Snapshot } from '../shared/types';
import { uiErrorMessage, userFailure } from '../shared/user-failure';

export function ProjectDirectoryForm({ projectId, projectName, contextKey, directory = '', initial = false, embedded = false, saved }: { projectId: string; projectName: string; contextKey: string; directory?: string; initial?: boolean; embedded?: boolean; saved: () => Promise<void> }) {
  const [value, setValue] = useState(directory), [operation, setOperation] = useState<'saving' | 'choosing' | 'refreshing' | ''>(''), [error, setError] = useState('');
  const [impactFailed, setImpactFailed] = useState(false), [settingsWriteDenied, setSettingsWriteDenied] = useState(false);
  const [confirmation, setConfirmation] = useState(''), pending = useRef(false);
  const [impact, setImpact] = useState<{ following: number; fixed: number; pending: number; failed: number }>();
  useEffect(() => { let active = true; window.workbench.call<typeof impact>('project.directory.impact', { projectId }).then(value => { if (active) setImpact(value); }).catch(() => {}); return () => { active = false; }; }, [projectId, contextKey]);
  const busy = !!operation;
  const edit = (next: string) => { setValue(next); setConfirmation(''); setError(''); };
  const save = async (next: string) => {
    if (pending.current) return;
    pending.current = true; setOperation('saving'); setError(''); setSettingsWriteDenied(false); setConfirmation('');
    try {
      const canonical = await window.workbench.call<string>('project.directory.save', { projectId, directory: next, contextKey });
      setValue(canonical); setConfirmation(canonical ? '代码目录已保存' : '已保存，新会话将自动创建独立目录');
      try {
        const state = await window.workbench.call<NonNullable<typeof impact>>('project.directory.impact', { projectId }); setImpact(state);
        setConfirmation(canonical ? state.failed ? '目录已保存，部分会话迁移待处理' : state.pending ? '目录已保存，等待当前任务结束后切换' : '代码目录已保存，跟随会话已切换' : '已保存，新会话将自动创建独立目录');
      } catch { setImpact(undefined); setImpactFailed(true); setError('代码目录已保存，不用再保存一次。暂时看不到哪些会话已搬到新目录，请点“查看搬移进度”。'); }
      try { await saved(); } catch { setError('目录已保存，但界面未能刷新，请重新打开项目设置。'); }
    } catch (reason) { setSettingsWriteDenied(userFailure(reason).code === 'FILE_ACCESS_DENIED'); setError(contextualError(reason, { domain: 'local', operation: '保存代码目录', outcome: 'not-started' }, { FILE_ACCESS_DENIED: '代码目录没有保存：Windows 不允许写入本机项目设置。输入还在。点“打开本机数据目录”，请管理员检查此目录的写入权限后，再点“保存代码目录”。' })); }
    finally { pending.current = false; setOperation(''); }
  };
  return <section className={(embedded ? '' : 'modal-body ') + 'project-directory-form'} aria-label="项目代码目录设置">
    <h3>{projectName} · 本机代码目录</h3>
    <p className="muted small">{initial ? '可选择本机代码目录。新会话和设置为“跟随项目”的已有会话会使用此目录。' : '此目录仅保存在本机。修改后，跟随项目的会话会一起切换；正在运行的会话完成当前轮后再切换。'}文件复制并校验后才切换，原文件保留；同名冲突另存副本。留空不会移动已有文件。</p>
    {impact && <p className="muted small" role="status">{impact.following} 个会话跟随项目 · {impact.fixed} 个会话保留独立目录{impact.pending > 0 ? ` · ${impact.pending} 个待切换` : ''}{impact.failed > 0 ? `（${impact.failed} 个迁移遇到问题，请在会话归属中查看）` : ''}</p>}
    <label className="field">代码目录（选填）<div className="row"><input aria-label="代码目录（选填）" disabled={busy} value={value} placeholder="留空用于调研，每次会话自动创建独立目录" onChange={event => edit(event.target.value)}/><button className="secondary" disabled={busy} title="选择项目代码目录" onClick={async () => {
      if (pending.current) return;
      pending.current = true; setOperation('choosing'); setError(''); setSettingsWriteDenied(false);
      try { const chosen = await window.workbench.call<string>('choose.directory'); if (chosen && chosen !== value) edit(chosen); }
      catch (reason: any) { setError(contextualError(reason, { domain: 'local', operation: '选择本机代码目录' }, { FILE_ACCESS_DENIED: '目录选择窗口没能打开。你也可以直接在左边输入完整的代码目录，再点“保存代码目录”。' })); } finally { pending.current = false; setOperation(''); }
    }}><FolderOpen size={16}/>{operation === 'choosing' ? '正在选择…' : '选择目录'}</button></div></label>
    {error && <div className="inline-error" role="alert">{error} {settingsWriteDenied && <button className="text-button" onClick={() => void window.workbench.call('open.data').catch(reason => setError(uiErrorMessage(reason, { domain: 'local', operation: '打开本机数据目录' })))}>打开本机数据目录</button>} <ErrorLogLink message={error}/></div>}
    {impactFailed && <button className="secondary" disabled={busy} onClick={async () => { setOperation('refreshing'); try { const state = await window.workbench.call<NonNullable<typeof impact>>('project.directory.impact', { projectId }); setImpact(state); setImpactFailed(false); setError(''); } catch { setError('目录还是已保存的。搬移进度这次也没读出来，稍后再点“查看搬移进度”。'); } finally { setOperation(''); } }}>{operation === 'refreshing' ? '正在查看搬移进度…' : '查看搬移进度'}</button>}
    <div className="row project-directory-actions">{initial && <button className="secondary" disabled={busy} onClick={() => void save('')}>暂不设置</button>}<button className="primary" disabled={busy} onClick={() => void save(value)}>{operation === 'saving' ? '正在保存…' : initial ? '保存并进入项目' : '保存代码目录'}</button>{confirmation && <span className="project-directory-confirmation" role="status"><Check size={15}/>{confirmation}</span>}</div>
  </section>;
}

export function SessionDirectoryStatus({ session }: { session: AgentSession }) {
  if (!session.directoryMove) return null;
  return <span className={session.directoryMove.error ? 'inline-error small' : 'muted small'} role="status" title={`当前：${session.cwd}\n目标：${session.directoryMove.to}\n${session.directoryMove.error || '当前任务结束后自动切换'}\n可在“管理会话归属”中查看。`}>{session.directoryMove.error ? ' · 目录迁移待处理' : ' · 目录待切换'}</span>;
}

export function ProjectDirectoryDialog(props: React.ComponentProps<typeof ProjectDirectoryForm>) {
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-label="设置项目代码目录"><header><h2>设置项目代码目录</h2></header><ProjectDirectoryForm {...props} initial/></section></div>;
}

type ProjectMembers = { accessKey?: string; groupId: string; groupLabel: string; connected: boolean; call: (command: GroupCommand) => Promise<any>; changed: () => Promise<void> };

export function ProjectSettingsDialog({ project, admin, contextKey, directory, members, central, syncState, initialTab = 'project', close, directorySaved, briefSaved }: { project: Project; admin: boolean; contextKey: string; directory?: string; members?: ProjectMembers; central?: React.ReactNode; initialTab?: 'project' | 'central'; syncState?: NonNullable<Snapshot['projectSync']>[string]; close: () => void; directorySaved: () => Promise<void>; briefSaved: (revision: number) => Promise<void> }) {
  const [tab, setTab] = useState<'project' | 'members' | 'recommendations' | 'central'>(initialTab), [membersOpened, setMembersOpened] = useState(false), [recommendationsOpened, setRecommendationsOpened] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false), [syncError, setSyncError] = useState('');
  useEffect(() => { if (syncState?.historyOnly && (tab === 'members' || tab === 'recommendations')) setTab('project'); }, [syncState?.historyOnly, tab]);
  return <div className="modal-backdrop"><section className="modal wide" role="dialog" aria-label={'项目设置 · ' + project.name}>
    <header><h2>项目设置 · {project.name}</h2><button className="icon" aria-label="关闭窗口" onClick={close}>×</button></header>
    <div className="project-settings-tabs" role="tablist" aria-label="项目设置分类">
      <button role="tab" id="project-settings-project-tab" aria-selected={tab === 'project'} aria-controls="project-settings-project-panel" onClick={() => setTab('project')}>项目资料</button>
      {central && <button role="tab" id="project-settings-central-tab" aria-selected={tab === 'central'} aria-controls="project-settings-central-panel" onClick={() => setTab('central')}>中央节点</button>}
      {!syncState?.historyOnly && <button role="tab" id="project-settings-ai-tab" aria-selected={tab === 'recommendations'} aria-controls="project-settings-ai-panel" onClick={() => { setRecommendationsOpened(true); setTab('recommendations'); }}>AI推荐</button>}
      {members && <button role="tab" id="project-settings-members-tab" aria-selected={tab === 'members'} aria-controls="project-settings-members-panel" onClick={() => { setMembersOpened(true); setTab('members'); }}>成员与权限</button>}
    </div>
    <div className="project-settings-pane" id="project-settings-project-panel" role="tabpanel" aria-labelledby={members ? 'project-settings-project-tab' : undefined} hidden={tab !== 'project'}>
      {syncState && <div className="modal-body"><p role="status">{syncState.historyOnly ? '本地历史项目，资料仅保存在本机' : syncState.localOnly ? '本机已保存' : syncState.conflict ? '项目资料有分歧待处理' : syncState.error ? '本机已保存，等待自动同步：' + syncState.error : syncState.pending ? '本机已保存，资料待同步' : '项目资料已同步'}</p>{syncError && <p className="inline-error">{syncError}</p>}{syncState.conflict && <SyncConflictCard key={syncState.conflict.token} conflict={syncState.conflict} busy={syncBusy} resolve={async (choice, fields) => { setSyncBusy(true); setSyncError(''); try { await window.workbench.call('project.sync.resolve', { projectId: project.id, token: syncState.conflict!.token, choice, fields }); await directorySaved(); } catch (error: any) { setSyncError(error.message); } finally { setSyncBusy(false); } }}/>}</div>}
      {!!syncState?.history?.length && <details className="modal-body"><summary>合并记录与恢复</summary>{syncState.history.map(item => <div className="row" key={item.id}><span>{new Date(item.at).toLocaleString()}</span><button className="text-button" disabled={syncBusy} onClick={async () => { setSyncBusy(true); setSyncError(''); try { await window.workbench.call('project.sync.undo', { projectId: project.id, id: item.id }); await directorySaved(); } catch (error: any) { setSyncError(error.message); } finally { setSyncBusy(false); } }}>恢复处理前版本</button></div>)}</details>}
      <ProjectBriefSettings project={project} admin={admin} cancel={close} saveLabel="保存项目设置" saved={briefSaved} localSettings={<ProjectDirectoryForm projectId={project.id} projectName={project.name} contextKey={contextKey} directory={directory} saved={directorySaved} embedded/>}/>
    </div>
    {central && <div className="project-settings-pane" id="project-settings-central-panel" role="tabpanel" aria-labelledby="project-settings-central-tab" hidden={tab !== 'central'}>{central}</div>}
    <div className="project-settings-pane" id="project-settings-ai-panel" role="tabpanel" aria-labelledby="project-settings-ai-tab" hidden={tab !== 'recommendations'}>{!syncState?.historyOnly && recommendationsOpened && <RsiProjectSettings projectId={project.id}/>}</div>
    {members && <div className="project-settings-pane" id="project-settings-members-panel" role="tabpanel" aria-labelledby="project-settings-members-tab" hidden={tab !== 'members'}>
      <p className="project-members-scope">管理「{project.name}」的成员与角色。</p>
      {!members.connected && <p className="muted small">当前显示本地缓存；连接中央节点后更新成员与权限。</p>}{membersOpened && <TeamGroupDialog key={members.accessKey} embedded groupId={members.groupId} call={members.call} close={close} changed={members.changed}/>}
    </div>}
  </section></div>;
}
