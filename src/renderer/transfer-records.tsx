import React from 'react';
import { FileArchive, RefreshCw } from 'lucide-react';
import type { Transfer } from '../shared/types';
import { fullDestination, submissionDestination } from '../shared/submission';
import { SubmissionDetails } from './submission-details';

const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
export function TransferRecords({ transfers, retry }: { transfers: Transfer[]; retry: (id: string) => void }) {
  const targets = transfers.map(item => item.submission?.destination || item.metadata?.submission?.destination || submissionDestination(item.binding.project));
  const multipleProjects = new Set(targets.map(target => `${target.groupName || ''}:${target.projectId}`)).size > 1;
  return <>{transfers.map((item, index) => {
    const record = item.submission || item.metadata?.submission, destination = targets[index];
    const ambiguous = targets.some(target => target.projectName === destination.projectName && (target.projectId !== destination.projectId || target.groupName !== destination.groupName));
    return <article className="transfer-card" key={item.id}>
      <div className="row"><FileArchive size={22}/><b>{item.kind === 'download' ? '下载' : item.kind === 'history' ? '轨迹上传' : '上传'} · {item.metadata?.title || item.name}</b><span className="spacer"/><span className={'badge ' + item.status}>{({ queued: '排队中', running: '正在传输', done: '已完成', error: '未完成' })[item.status]}</span></div>
      {multipleProjects && <p>{ambiguous ? fullDestination(destination) : destination.projectName}</p>}
      {item.status !== 'done' && <progress aria-label="传输进度" max={item.total || 1} value={item.bytes}/>}
      <div className="row"><span className="muted small">{bytes(item.bytes)} / {bytes(item.total)} · {new Date(item.createdAt).toLocaleString()}</span><span className="spacer"/>{item.status === 'error' && <button className="secondary compact" disabled={!!item.cacheCleared} onClick={() => retry(item.id)}><RefreshCw size={13}/>重试</button>}</div>
      {item.kind === 'upload' ? <SubmissionDetails record={record} destination={destination} legacyAuthor={item.binding.username} legacySource={item.metadata?.sourceSessionTitle} summary="查看详情"><p>远端位置</p><code>{item.target}</code></SubmissionDetails> : <details className="submission-details"><summary>查看详情</summary><p>账号：{item.binding.username} · {fullDestination(destination)}</p><p>远端位置</p><code>{item.target}</code>{item.kind === 'download' && <><p>保存到</p><code>{item.localPath}</code></>}</details>}
      {item.cacheCleared && <p className="muted small">本机上传缓存已清理</p>}
      {item.error && <div className="inline-error" role="alert">{item.error}</div>}
    </article>;
  })}</>;
}
