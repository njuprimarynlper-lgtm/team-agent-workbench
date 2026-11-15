import React, { useEffect, useState } from 'react';
import type { AgentSession } from '../shared/types';
import type { LogStatus, LogExportInput } from '../shared/logs';
import './logs-panel.css';
import { MarkdownEditor } from './markdown-editor';

type API = { call<T = unknown>(action: string, payload?: unknown): Promise<T> };
const size = (bytes = 0) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
export function LogsPanel({ api, sessions = [], close }: { api: API; sessions?: AgentSession[]; close(): void }) {
  const [status, setStatus] = useState<LogStatus>(), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [projectId, setProject] = useState(''), [sessionId, setSession] = useState(''), [description, setDescription] = useState('');
  const refresh = () => api.call<LogStatus>('logs.status').then(setStatus);
  useEffect(() => { void refresh().catch(error => setError(error.message)); }, []);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) close(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [busy, close]);
  const run = async (operation: () => Promise<any>) => { if (busy) return; setBusy(true); setError(''); setMessage(''); try { const result = await operation(); if (!result?.canceled) setMessage(result?.path ? `已导出：${result.path}` : '清理完成'); await refresh(); } catch (error: any) { setError(error.message); } finally { setBusy(false); } };
  const exportKind = (kind: LogExportInput['kind']) => run(() => api.call('logs.export', { kind, ...(from ? { from: new Date(from).toISOString() } : {}), ...(to ? { to: new Date(to).toISOString() } : {}), ...(projectId ? { projectId } : {}), ...(sessionId ? { sessionId } : {}), ...(description ? { description } : {}) }));
  const projects = [...new Map(sessions.filter(session => session.binding).map(session => [session.binding!.project.id, session.binding!.project.name])).entries()];
  const selected = sessions.find(session => session.id === sessionId), traceAllowed = selected && !['starting', 'running', 'approval'].includes(selected.status);
  return <div className="logs-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close(); }}><section className="logs-panel" role="dialog" aria-modal="true" aria-label="日志与分析">
    <header><h2>日志与分析</h2><button aria-label="关闭日志与分析" disabled={busy} onClick={close}>×</button></header>
    <div className="logs-body">
      <p>本机保存，主动导出。普通日志不包含对话、工具正文、附件和登录凭据。</p>
      {error && <p className="logs-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <div className="logs-usage">{(['diagnostic', 'workflow'] as const).map(kind => <div key={kind}><strong>{kind === 'diagnostic' ? '故障排查' : '工作流分析'}</strong><p>{size(status?.[kind].bytes)} / {size(status?.[kind].limit)}</p><small>保留 {status?.[kind].days || (kind === 'diagnostic' ? 14 : 90)} 天，空间超限时优先清理最旧记录</small></div>)}<div><strong>完整执行轨迹</strong><p>{size(status?.traces.bytes)} · {status?.traces.sessions || 0} 个会话</p><small>属于会话资料，不因日志限额删除</small></div></div>
      <p className="logs-status">最近写入：{status?.lastWrite ? new Date(status.lastWrite).toLocaleString() : '暂无'} · 已抑制 {status?.suppressed || 0} 条 · 队列 {status?.queued || 0} 条 / {size(status?.queueBytes)}</p>
      {(status?.error || status?.traceError || sessions.some(session => session.traceIncomplete)) && <p className="logs-error" role="alert">{status?.traceError ? '完整轨迹存在未持久化记录：' + status.traceError : status?.error ? '日志写入暂不可用：' + status.error : '部分会话曾有轨迹未能持久化'}。恢复磁盘或目录权限后会尝试继续；已缺失部分不会标为完整。</p>}
      <div className="logs-filters"><label>开始时间<input type="datetime-local" value={from} disabled={busy} onChange={event => setFrom(event.target.value)}/></label><label>结束时间<input type="datetime-local" value={to} disabled={busy} onChange={event => setTo(event.target.value)}/></label><label>项目<select value={projectId} disabled={busy} onChange={event => { setProject(event.target.value); setSession(''); }}><option value="">当前账号全部项目</option>{projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label>会话<select value={sessionId} disabled={busy} onChange={event => setSession(event.target.value)}><option value="">全部会话</option>{sessions.filter(session => !projectId || session.binding?.project.id === projectId).map(session => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label></div>
      <label>问题描述（可选）<MarkdownEditor value={description} maxLength={2000} disabled={busy} onChange={event => setDescription(event.target.value)} placeholder="发生时间、操作步骤、实际现象"/></label>
      <div className="logs-actions"><button disabled={busy} onClick={() => void exportKind('diagnostic')}>导出故障诊断包</button><button disabled={busy} onClick={() => void exportKind('workflow')}>导出工作流分析包</button><button disabled={busy} onClick={() => void run(() => api.call('logs.cleanup', { kind: 'ordinary' }))}>清理普通日志</button></div>
      <details><summary>完整执行轨迹</summary><p>包含对话和工具执行内容。请选择已停止执行的会话，再单独导出或删除；对话和成果不会随轨迹删除。</p><div className="logs-actions"><button disabled={busy || !traceAllowed} onClick={() => void exportKind('trace')}>导出完整轨迹</button><button disabled={busy || !traceAllowed} onClick={() => void run(() => api.call('logs.cleanup', { kind: 'trace', sessionId }))}>删除所选轨迹</button></div></details>
      <p><small>工作流包附操作次数、成功/失败/取消及阶段耗时汇总。日志缺失和限流会在包内说明；应用未操作的时间不直接认定为低效。</small></p>
    </div><footer><button disabled={busy} onClick={() => void refresh().catch(error => setError(error.message))}>刷新状态</button><button disabled={busy} onClick={close}>{busy ? '处理中…' : '关闭'}</button></footer>
  </section></div>;
}
