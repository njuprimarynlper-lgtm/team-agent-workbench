import React, { useEffect, useRef, useState } from 'react';
import { Server } from 'lucide-react';
import type { ConnectionProfile } from '../shared/types';
import type { WorkspaceAccess } from '../shared/types';

export function LocalProjectConnection({ projectId, profile, groups, configure, linked }: { projectId: string; profile?: ConnectionProfile; groups: WorkspaceAccess[]; configure: () => void; linked: () => Promise<void> }) {
  const [selection, setSelection] = useState({ connection: '', group: '' }), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  const connection = profile ? `${projectId}:${profile.mode}:${profile.host}:${profile.port}:${profile.username}:${profile.localRoot || ''}` : '';
  const available = groups.filter(group => group.canCreateProject && !group.accessError);
  const groupName = selection.connection === connection && available.some(group => group.groupName === selection.group) ? selection.group : available.length === 1 ? available[0].groupName : '';
  useEffect(() => { setError(''); }, [connection]);
  return <section className="modal-body" aria-label="关联项目中央节点">
    {profile ? <>
      <div className="row"><Server size={19}/><strong>{profile.host}:{profile.port}</strong><span className="spacer"/><button className="text-button" disabled={busy} onClick={configure} aria-label="更换中央节点">更换</button></div>
      <p className="muted small">账号：{profile.username}</p>
      {available.length === 1 ? <p>工作组：<strong>{available[0].groupLabel || available[0].groupName}</strong></p> : available.length > 1 ? <label className="field">工作组<select aria-label="关联工作组" disabled={busy} value={groupName} onChange={event => setSelection({ connection, group: event.target.value })}><option value="">选择工作组</option>{available.map(group => <option key={group.groupName} value={group.groupName}>{group.groupLabel || group.groupName}</option>)}</select></label> : <p className="muted small" role="status">当前账号没有可关联的工作组，请联系工作组管理者开通项目创建权限，或更换连接。</p>}
      <button className="primary" disabled={busy || !groupName} onClick={async () => { if (pending.current || !groupName) return; pending.current = true; setBusy(true); setError(''); try { await window.workbench.call('project.link', { projectId, groupName }); await linked(); } catch (reason: any) { setError(reason.message); } finally { pending.current = false; setBusy(false); } }}>{busy ? '正在关联…' : '关联项目'}</button>
      {!!groupName && <p className="muted small">关联后自动同步本项目资料。</p>}
    </> : <button className="primary" disabled={busy} onClick={configure}>连接中央节点</button>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}

export function ProjectConnectionEntry({ connected, local, open }: { connected: boolean; local?: boolean; open: () => void }) {
  return <button type="button" className="project-connection-entry" onClick={open}><Server size={13}/><span>中央节点</span><span className={'project-connection-state' + (connected ? ' is-connected' : '')}>{connected ? '已连接' : local ? '未关联' : '未连接'}</span></button>;
}

export function ProjectCentralConnection({ profile, connected, configure, disconnect }: { profile: ConnectionProfile; connected: boolean; configure: () => void; disconnect?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <section className="modal-body" aria-label="项目中央节点"><div className="row"><Server size={19}/><strong>{profile.host}:{profile.port}</strong><span className="spacer"/><span className={connected ? 'green small' : 'muted small'}>{busy ? '正在断开…' : connected ? '已连接' : '未连接'}</span></div><p>成员账号：{profile.username}</p><p className="muted small">{connected ? '当前项目自动同步。断开只影响本项目，本地会话可继续。' : '连接后同步本项目的资料、成果和提问。可复用已登录的连接。'}</p>{error && <p className="inline-error" role="alert">{error}</p>}{connected ? <button className="secondary" disabled={busy || !disconnect} onClick={async () => { setBusy(true); setError(''); try { await disconnect?.(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>断开本项目</button> : <button className="primary" disabled={busy} onClick={configure}>连接</button>}</section>;
}
