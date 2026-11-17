import React, { useState } from 'react';
import { FileArchive, RefreshCw } from 'lucide-react';
import type { Transfer } from '../shared/types';
import { fullDestination, submissionDestination } from '../shared/submission';
import { SubmissionDetails } from './submission-details';
import { transferRecordError } from '../shared/transfer-failure';
import { ErrorLogLink } from './error-notice';

const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
export function TransferRecords({ transfers, retry }: { transfers: Transfer[]; retry: (id: string) => void }) {
  const [saving, setSaving] = useState('');
  const saveRecord = async (id: string) => {
    setSaving(id);
    try { await window.workbench.call('transfer.retrySave', { id }); }
    catch { /* The queue publishes the retained completion and new save warning. */ }
    finally { setSaving(''); }
  };
  const targets = transfers.map(item => item.submission?.destination || item.metadata?.submission?.destination || submissionDestination(item.binding.project));
  const byId = new Map(transfers.map(item => [item.id, item]));
  const multipleProjects = new Set(targets.map(target => `${target.groupName || ''}:${target.projectId}`)).size > 1;
  return <>{transfers.map((item, index) => {
    const record = item.submission || item.metadata?.submission, destination = targets[index];
    const ambiguous = targets.some(target => target.projectName === destination.projectName && (target.projectId !== destination.projectId || target.groupName !== destination.groupName));
    const attachments = (item.dependsOn || []).flatMap(id => { const transfer = byId.get(id); return transfer ? [transfer] : []; });
    const progressBytes = item.bytes + attachments.reduce((total, file) => total + file.bytes, 0);
    const progressTotal = item.total + attachments.reduce((total, file) => total + file.total, 0);
    const attachmentRunning = item.status === 'queued' && attachments.some(file => file.status === 'running');
    return <article className="transfer-card" key={item.id}>
      <div className="row"><FileArchive size={22}/><b>{item.kind === 'download' ? '下载' : item.kind === 'history' ? '轨迹上传' : item.attachment ? '附件上传' : '上传'} · {item.attachment ? item.name : item.metadata?.title || item.name}</b><span className="spacer"/><span className={'badge ' + (attachmentRunning ? 'running' : item.status)}>{attachmentRunning ? '附件上传中' : ({ queued: '排队中', running: '正在传输', done: '已完成', error: item.phase === 'awaiting_receipt' ? '结果待确认' : '未完成' })[item.status]}</span></div>
      {multipleProjects && <p>{ambiguous ? fullDestination(destination) : destination.projectName}</p>}
      {item.status !== 'done' && <progress aria-label={attachments.length ? '成果及附件传输进度' : '传输进度'} max={progressTotal || 1} value={progressBytes}/>}
      <div className="row"><span className="muted small">{bytes(progressBytes)} / {bytes(progressTotal)}{(item.status === 'running' || attachmentRunning) && progressTotal > 0 ? ` · ${Math.min(100, Math.floor(progressBytes / progressTotal * 100))}%` : ''} · {new Date(item.createdAt).toLocaleString()}</span><span className="spacer"/>{item.status === 'error' && <button className="secondary compact" disabled={!!item.cacheCleared} onClick={() => retry(item.id)}><RefreshCw size={13}/>{item.phase === 'awaiting_receipt' && !item.cacheCleared ? '检查上传结果' : '重试'}</button>}</div>
      {item.kind === 'upload' && !item.attachment ? <SubmissionDetails record={record} destination={destination} legacyAuthor={item.binding.username} legacySource={item.metadata?.sourceSessionTitle} summary="查看详情"><p>远端位置</p><code>{item.target}</code></SubmissionDetails> : <details className="submission-details"><summary>查看详情</summary><p>账号：{item.binding.username} · {fullDestination(destination)}</p><p>远端位置</p><code>{item.target}</code>{item.kind === 'download' && <><p>保存到</p><code>{item.localPath}</code></>}</details>}
      {item.error && <div className="inline-error" role="alert">{transferRecordError(item)} <ErrorLogLink failure={(item as any).failure} message={item.error}/>{item.status === 'done' && item.phase === 'completed' && <button className="text-button" style={{marginLeft:10}} disabled={saving === item.id} onClick={() => void saveRecord(item.id)}>{saving === item.id ? '正在保存记录…' : '重试保存记录'}</button>}</div>}
    </article>;
  })}</>;
}
