import React, { useState } from 'react';
import { Server } from 'lucide-react';
import type { ConnectionProfile } from '../shared/types';

// Compatibility only: older local projects remain accessible, but new projects
// always belong to a central node from creation.
export function LocalProjectConnection({ create }: { create: () => void }) {
  return <section className="modal-body" aria-label="旧版本本机项目"><p>这是旧版本创建的本机项目，已有资料和会话仍保留。可创建中央节点项目后，通过会话菜单迁移会话。</p><button className="primary" onClick={create}>创建中央节点项目</button></section>;
}

export function ProjectConnectionEntry({ connected, local, open }: { connected: boolean; local?: boolean; open: () => void }) {
  const label = connected ? '同步已开启' : local ? '仅本机（旧版）' : '未开启同步';
  return <button type="button" className="project-connection-entry" aria-label={'项目同步：' + label} title={'项目同步：' + label + '，点击管理同步'} onClick={open}><span className={'project-connection-dot' + (connected ? ' is-connected' : '')} aria-hidden="true"/><span className={'project-connection-state' + (connected ? ' is-connected' : '')}>{label}</span></button>;
}

export function ProjectCentralConnection({ profile, connected, configure, disconnect }: { profile: ConnectionProfile; connected: boolean; configure: () => void; disconnect?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <section className="modal-body" aria-label="项目中央节点"><div className="row"><Server size={19}/><strong>{profile.host}:{profile.port}</strong><span className="spacer"/><span className={connected ? 'green small' : 'muted small'}>{busy ? '正在断开…' : connected ? '已连接' : '未连接'}</span></div><p>成员账号：{profile.username}</p><p className="muted small">{connected ? '当前项目自动同步。断开只影响本项目，本地会话可继续。' : '连接后同步本项目的资料、成果和提问。可复用已登录的连接。'}</p>{error && <p className="inline-error" role="alert">{error}</p>}{connected ? <button className="secondary" disabled={busy || !disconnect} onClick={async () => { setBusy(true); setError(''); try { await disconnect?.(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>断开本项目</button> : <button className="primary" disabled={busy} onClick={configure}>连接</button>}</section>;
}
