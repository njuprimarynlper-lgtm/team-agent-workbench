import { contextualError } from './contextual-error';
import { ErrorLogLink } from './error-notice';
import { userFailure } from '../shared/user-failure';
import { projectSyncLabel, type ProjectConnectionState } from '../shared/project-connection';
import React, { useEffect, useState } from 'react';
import { Server } from 'lucide-react';
import type { ConnectionProfile } from '../shared/types';

// Compatibility only: older local projects remain accessible, but new projects
// always belong to a central node from creation.
export function LocalProjectConnection({ create }: { create: () => void }) {
  return <section className="modal-body" aria-label="旧版本本机项目"><p>这是旧版本创建的本机项目，已有资料和会话仍保留。可创建中央节点项目后，通过会话菜单迁移会话。</p><button className="primary" onClick={create}>创建中央节点项目</button></section>;
}

export function ProjectConnectionEntry({ connected, state, local, open }: { connected: boolean; state?: ProjectConnectionState; local?: boolean; open: () => void }) {
  const label = local ? '仅本机（旧版）' : projectSyncLabel(state || { connected });
  const tone = label === '已同步' ? ' is-connected' : label === '未同步' || label === '待处理' ? ' is-unsynced' : '';
  return <button type="button" className="project-connection-entry" aria-label={'项目同步：' + label} title={'项目同步：' + label + (label === '已同步' ? '，项目资料已更新到工作台；共享成果仍需选择加入会话。' : '') + (state?.failure ? '。' + state.failure.message : '') + ' 点击管理同步'} onClick={open}><span className={'project-connection-dot' + tone} aria-hidden="true"/><span className={'project-connection-state' + tone}>{label}</span></button>;
}

export function ProjectCentralConnection({ profile, connected, state, configure, retry, disconnect }: { profile: ConnectionProfile; connected: boolean; state?: ProjectConnectionState; configure: () => void; retry?: () => Promise<void>; disconnect?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [disconnectedLocally, setDisconnectedLocally] = useState(false);
  const [feedback, setFeedback] = useState('');
  useEffect(() => { if (state?.syncStatus === 'synced') { setFeedback(''); setError(''); } }, [state?.syncStatus]);
  connected = connected && !disconnectedLocally;
  const current: ProjectConnectionState = disconnectedLocally ? { connected: false, syncStatus: 'paused' } : state || { connected };
  const resume = async () => {
    setBusy(true); setError(''); setFeedback('');
    try { if (retry) { await retry(); setFeedback('已安排同步，结果会在这里更新。'); } else configure(); setDisconnectedLocally(false); }
    catch (e) { setError(contextualError(e, { domain: 'central', operation: '恢复项目同步' }, {})); }
    finally { setBusy(false); }
  };
  return <section className="modal-body" aria-label="项目中央节点">
    <div className="row"><Server size={19}/><strong>{profile.host}:{profile.port}</strong><span className="spacer"/><span className={current.syncStatus === 'synced' ? 'green small' : 'muted small'} role="status">{projectSyncLabel(current)}</span></div>
    <p>成员账号：{profile.username}</p>
    <p className="muted small">{current.syncStatus === 'paused' ? '本次登录中已暂停本项目同步，本机会话可继续。下次登录会自动恢复。' : current.failure?.code === 'ACCOUNT_SYNC_CACHE_UNREADABLE' ? '项目资料尚未全部同步，请按下方提示处理。' : connected ? '项目资料、成果和提问自动同步到工作台。共享成果仍需选择加入会话；同步失败会自动重试。' : '连接中央节点后，后台会自动同步此账号可访问的项目。'}</p>
    {current.failure && current.syncStatus !== 'paused' && <p className="inline-error" role="alert">{current.failure.message} <ErrorLogLink failure={current.failure} message={current.failure.message}/></p>}
    {current.syncStatus === 'conflict' && current.failure?.code !== 'ACCOUNT_SYNC_CONFLICT' && <p>项目说明存在不同版本，请在“项目说明”中处理，本机版本仍保留。</p>}
    {error && <p className="inline-error" role="alert">{error} <ErrorLogLink message={error}/></p>}
    {feedback && <p className="muted small" role="status">{feedback}</p>}
    <div className="row">
      {(!connected || current.syncStatus === 'unsynced') && <button className="primary" disabled={busy} onClick={() => void resume()}>{busy ? '正在处理…' : connected ? '立即重试' : current.syncStatus === 'paused' ? '恢复同步' : '连接'}</button>}
      {connected && <button className="secondary" disabled={busy || !disconnect} onClick={async () => { setBusy(true); setError(''); try { await disconnect?.(); } catch (e: any) { if (userFailure(e).code === 'PROJECT_DISCONNECTED_WITH_PENDING_SYNC') setDisconnectedLocally(true); setError(contextualError(e, { domain: 'central', operation: '暂停项目同步' }, { UNCLASSIFIED_FAILURE: '暂时不知道本项目是否已暂停。请关闭再打开项目设置，查看同步状态，再决定是否暂停。' })); } finally { setBusy(false); } }}>暂停本项目同步</button>}
    </div>
  </section>;
}
