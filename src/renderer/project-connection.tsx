import React, { useState } from 'react';
import { Server } from 'lucide-react';
import type { ConnectionProfile } from '../shared/types';
import type { WorkspaceAccess } from '../shared/types';

export function LocalProjectConnection({ projectId, profile, groups, configure, linked }: { projectId: string; profile?: ConnectionProfile; groups: WorkspaceAccess[]; configure: () => void; linked: () => Promise<void> }) {
  const [groupName, setGroupName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <section className="modal-body"><p>选择中央节点和工作组，关联后开始同步本项目。</p>
    {profile && <><p>{profile.host}:{profile.port} · {profile.username}</p><label className="field">同步到工作组<select value={groupName} onChange={event => setGroupName(event.target.value)}><option value="">请选择</option>{groups.map(group => <option key={group.groupName} value={group.groupName}>{group.groupLabel || group.groupName}</option>)}</select></label><button className="primary" disabled={busy || !groupName} onClick={async () => { setBusy(true); setError(''); try { await window.workbench.call('project.link', { projectId, groupName }); await linked(); } catch (reason: any) { setError(reason.message); } finally { setBusy(false); } }}>{busy ? '正在关联…' : '关联并自动同步'}</button></>}
    <button className="text-button central-connection-link" disabled={busy} onClick={configure}>{profile ? '选择其他连接' : '连接中央节点'}</button>{error && <p className="inline-error">{error}</p>}
  </section>;
}

export function ProjectConnectionEntry({ connected, local, open }: { connected: boolean; local?: boolean; open: () => void }) {
  return <button type="button" className="project-connection-entry" onClick={open}><Server size={13}/><span>中央节点</span><span className={'project-connection-state' + (connected ? ' is-connected' : '')}>{connected ? '已连接' : local ? '未关联' : '未连接'}</span></button>;
}

export function ProjectCentralConnection({ profile, connected, configure, disconnect }: { profile: ConnectionProfile; connected: boolean; configure: () => void; disconnect?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <section className="modal-body" aria-label="项目中央节点"><div className="row"><Server size={19}/><strong>{profile.host}:{profile.port}</strong><span className="spacer"/><span className={connected ? 'green small' : 'muted small'}>{busy ? '正在断开…' : connected ? '已连接' : '未连接'}</span></div><p>成员账号：{profile.username}</p><p className="muted small">{connected ? '当前项目自动同步。断开只影响本项目，本地会话可继续。' : '连接后同步本项目的资料、成果和提问。可复用已登录的连接。'}</p>{error && <p className="inline-error" role="alert">{error}</p>}{connected ? <button className="secondary" disabled={busy || !disconnect} onClick={async () => { setBusy(true); setError(''); try { await disconnect?.(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>断开本项目</button> : <button className="primary" disabled={busy} onClick={configure}>连接本项目</button>}</section>;
}
