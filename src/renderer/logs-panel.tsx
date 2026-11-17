import React, { useEffect, useRef, useState } from 'react';
import type { AgentSession } from '../shared/types';
import type { LogStatus, LogExportInput, LogRef, LogQueryResult, LogDetailResult } from '../shared/logs';
import './logs-panel.css';
import { MarkdownEditor } from './markdown-editor';
import { logTitle } from '../shared/log-labels';

type API = { call<T = unknown>(action: string, payload?: unknown): Promise<T> };
const size = (bytes = 0) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
export function LogsPanel({ api, sessions = [], close, logRef }: { api: API; sessions?: AgentSession[]; close(): void; logRef?: LogRef }) {
  const [status, setStatus] = useState<LogStatus>(), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [projectId, setProject] = useState(''), [sessionId, setSession] = useState(''), [description, setDescription] = useState('');
  const [query, setQuery] = useState<LogQueryResult>(), [detail, setDetail] = useState<LogDetailResult>(), [loading, setLoading] = useState(false), [detailLoading, setDetailLoading] = useState(false), [queryError, setQueryError] = useState(''), [detailError, setDetailError] = useState('');
  const [readAt, setReadAt] = useState(''), [pagesRead, setPagesRead] = useState(0), [openingDirectory, setOpeningDirectory] = useState(false), [directoryMessage, setDirectoryMessage] = useState('');
  const [statusError, setStatusError] = useState('');
  const queryRevision = useRef(0), detailRevision = useRef(0);
  const detailElement = useRef<HTMLDivElement>(null), queryErrorElement = useRef<HTMLDivElement>(null);
  const filters = () => ({ ...(from ? { from: new Date(from).toISOString() } : {}), ...(to ? { to: new Date(to).toISOString() } : {}), ...(projectId ? { projectId } : {}), ...(sessionId ? { sessionId } : {}) });
  const load = async (more = false) => {
    const revision = ++queryRevision.current; setLoading(true); setQueryError('');
    try {
      const next = await api.call<LogQueryResult>('logs.query', { ...filters(), ...(logRef?.operationId ? { operationId: logRef.operationId } : {}), limit: 20, ...(more && query?.nextCursor ? { cursor: query.nextCursor } : {}) });
      if (revision === queryRevision.current) {
        setQuery(previous => ({ ...next, items: more ? [...previous?.items || [], ...next.items] : next.items }));
        setReadAt(new Date().toISOString()); setPagesRead(previous => more ? previous + 1 : 1);
      }
    } catch { if (revision === queryRevision.current) setQueryError('最新故障记录没读出来。请点“重试读取”再试。'); }
    finally { if (revision === queryRevision.current) setLoading(false); }
  };
  const inspect = async (id: string) => {
    const revision = ++detailRevision.current; setDetailLoading(true); setDetailError(''); setDetail(undefined);
    try { const result = await api.call<LogDetailResult>('logs.get', { id }); if (revision === detailRevision.current) setDetail(result); }
    catch { if (revision === detailRevision.current) setDetailError('这条故障的详情没读出来。请在列表中重新点击它。'); }
    finally { if (revision === detailRevision.current) setDetailLoading(false); }
  };
  const refresh = async () => { try { const next = await api.call<LogStatus>('logs.status'); setStatus(next); setStatusError(''); } catch (error) { setStatusError('日志用量没有读出来，故障记录仍可单独查看。'); throw error; } };
  const openDirectory = async () => {
    setOpeningDirectory(true); setDirectoryMessage('');
    try {
      const result = await api.call<{ location: 'logs' | 'data' }>('logs.openDirectory');
      setDirectoryMessage(result.location === 'data' ? '日志文件夹打不开，已打开它所在的数据文件夹。请让维护人员检查其中名为 logs 的文件或文件夹。' : '日志文件夹已打开。可把最新日志交给维护人员。');
    } catch { setDirectoryMessage('日志文件夹没有打开。请联系维护人员检查这台电脑上的日志文件。'); }
    finally { setOpeningDirectory(false); }
  };
  useEffect(() => { void refresh().catch(() => {}); }, []);
  useEffect(() => { void load(); if (logRef?.id) void inspect(logRef.id); return () => { queryRevision.current++; detailRevision.current++; }; }, [logRef?.id, logRef?.operationId]);
  useEffect(() => { if (!queryError && (detail || detailError)) detailElement.current?.scrollIntoView({ block: 'nearest' }); }, [detail, detailError, query?.items.length, queryError]);
  useEffect(() => { if (queryError) queryErrorElement.current?.scrollIntoView({ block: 'nearest' }); }, [queryError]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) close(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [busy, close]);
  const run = async (operation: () => Promise<any>, action = '清理日志') => {
    if (busy) return; setBusy(true); setError(''); setMessage('');
    try {
      const result = await operation(); if (result?.canceled) return;
      setMessage(result?.path ? `报告已保存：${result.path}` : '日志已清理。');
      try { await refresh(); } catch { setError(`${result?.path ? '报告已保存' : '日志已清理'}，用量统计还没更新。可点击“刷新记录”更新。`); }
      if (!result?.path) { setDetail(undefined); await load(); }
    } catch { setError(`${action}没能完成。请重试；仍失败时请联系维护人员。`); }
    finally { setBusy(false); }
  };
  const exportKind = (kind: LogExportInput['kind']) => run(() => api.call('logs.export', { kind, ...(from ? { from: new Date(from).toISOString() } : {}), ...(to ? { to: new Date(to).toISOString() } : {}), ...(projectId ? { projectId } : {}), ...(sessionId ? { sessionId } : {}), ...(description ? { description } : {}) }), '导出日志');
  const projects = [...new Map(sessions.filter(session => session.binding).map(session => [session.binding!.project.id, session.binding!.project.name])).entries()];
  const selected = sessions.find(session => session.id === sessionId), traceAllowed = selected && !['starting', 'running', 'approval'].includes(selected.status);
  return <div className="logs-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close(); }}><section className="logs-panel" role="dialog" aria-modal="true" aria-label="日志与分析">
    <header><h2>日志与分析</h2><button aria-label="关闭日志与分析" disabled={busy} onClick={close}>×</button></header>
    <div className="logs-body">
      <p>遇到问题时，可以导出故障报告交给维护人员。日志保存在这台电脑，不会自动上传。</p>
      {error && <p className="logs-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <details className="logs-storage-details"><summary>日志用量与存储状态</summary><div className="logs-usage">{(['diagnostic', 'workflow'] as const).map(kind => <div key={kind}><strong>{kind === 'diagnostic' ? '故障排查' : '工作流分析'}</strong><p>{status ? `${size(status[kind].bytes)} / ${size(status[kind].limit)}` : '未读取'}</p><small>保留 {status?.[kind].days || (kind === 'diagnostic' ? 14 : 90)} 天，空间超限时清理最旧记录</small></div>)}<div><strong>完整执行轨迹</strong><p>{status ? `${size(status.traces.bytes)} · ${status.traces.sessions} 个会话` : '未读取'}</p><small>不随普通日志一起删除</small></div></div>
      {statusError && <p className="logs-error" role="alert">{statusError}</p>}{status && <p className="logs-status">最近写入：{status.lastWrite ? new Date(status.lastWrite).toLocaleString() : '暂无'} · 已抑制 {status.suppressed} 条 · 队列 {status.queued} 条 / {size(status.queueBytes)}</p>}
      {(status?.error || status?.traceError || sessions.some(session => session.traceIncomplete)) && <p className="logs-error" role="alert">{status?.traceError ? '有些执行轨迹没有存到这台电脑上。' : status?.error ? '新的日志暂时无法保存。' : '部分会话的执行轨迹不完整。'}请检查这台电脑的磁盘空间和日志文件夹权限；恢复后会继续保存，已经缺失的内容无法补回。</p>}</details>
      <div className="logs-filters"><label>开始时间<input type="datetime-local" value={from} disabled={busy} onChange={event => setFrom(event.target.value)}/></label><label>结束时间<input type="datetime-local" value={to} disabled={busy} onChange={event => setTo(event.target.value)}/></label><label>项目<select value={projectId} disabled={busy} onChange={event => { setProject(event.target.value); setSession(''); }}><option value="">当前账号全部项目</option>{projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label>会话<select value={sessionId} disabled={busy} onChange={event => setSession(event.target.value)}><option value="">全部会话</option>{sessions.filter(session => !projectId || session.binding?.project.id === projectId).map(session => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label></div>
      <section className="logs-browser" aria-label="故障日志浏览"><div className="logs-browser-heading"><h3>{logRef?.operationId ? '这次操作的故障记录' : '最近故障'}</h3><div className="logs-browser-tools"><button disabled={busy || openingDirectory} onClick={() => void openDirectory()}>打开日志文件夹</button><button disabled={busy || loading} onClick={() => { void load(); void refresh().catch(() => {}); }}>{queryError ? '重试读取' : '刷新记录'}</button></div></div>
        <p className="logs-hint">这里只显示这台电脑上、当前账号的故障记录。切换中央节点后，会显示对应节点的记录。</p>
        {directoryMessage && <p className="logs-directory-result" aria-live="polite">{directoryMessage}</p>}
        {queryError && <div ref={queryErrorElement} className="logs-query-failure" role="alert"><p>{queryError}</p>{query && <p>下面是{readAt ? new Date(readAt).toLocaleTimeString() : '上次'}读取的旧记录。</p>}</div>}
        {loading && <p aria-live="polite">正在读取日志…</p>}
        {!loading && !queryError && query && !query.items.length && <p className="logs-hint">当前范围内暂无故障记录。</p>}
        <ul className={'logs-records' + (queryError ? ' logs-records-stale' : '')} aria-label="最近故障列表">{query?.items.map(row => <li key={row.id}><button aria-label={`查看 ${logTitle(row)} 日志`} title={queryError ? '请先重试读取，恢复后可查看详情' : undefined} onClick={() => void inspect(row.id)} disabled={busy || detailLoading || !!queryError}><span><strong>{logTitle(row)}</strong><small>{new Date(row.at).toLocaleString()}{row.count ? ` · 重复 ${row.count} 次` : ''}</small></span><span>{queryError ? '暂不能查看详情' : '查看详情'}</span></button></li>)}</ul>
        {query && <div className="logs-pagination" role="group" aria-label="故障记录分页"><p aria-live="polite">{queryError ? '上次读取' : '已显示'} {query.items.length} 条记录 · 已读取 {pagesRead} 页</p><button disabled={busy || loading || !!queryError || !query.nextCursor} onClick={() => void load(true)}>{query.nextCursor ? '加载更早故障' : query.coverage.truncated ? '已达到本次查询上限' : '当前查询没有更多记录'}</button></div>}
        {query?.coverage.legacyScopeSkipped ? <p className="logs-hint">部分客户端日志未记录账号或节点归属，未列入当前范围。</p> : null}
        {query && (query.coverage.truncated || query.coverage.malformed || query.coverage.missingFiles || query.coverage.unavailable) ? <p className="logs-hint">部分日志未能读取或已达到本次查询上限，请缩小时间范围后刷新；列表不保证完整。</p> : null}
        <div ref={detailElement} className="logs-selected-detail">{detailLoading && <p aria-live="polite">正在读取详情…</p>}{detailError && <p className="logs-error" role="alert">{detailError}</p>}
          {detail && !detail.record && <p className="logs-reference-missing">这条日志没有找到，可能已过期或不属于当前账号和中央节点。请先检查登录的账号与中央节点；仍找不到时，可以打开日志文件夹。没有日志不代表原操作失败。</p>}
          {detail?.coverage.truncated && <p className="logs-hint">本次详情查询已达到读取上限，尚未读取的记录无法确认是否存在。</p>}
          {detail?.record && <section className="logs-record-detail" aria-label="日志详情"><h4>{logTitle(detail.record)}</h4><p className="logs-hint">{new Date(detail.record.at).toLocaleString()} · 下方是排查详情，可连同故障报告交给维护人员。</p><details><summary>技术标识</summary><dl><dt>事件</dt><dd>{detail.record.name}</dd><dt>错误编号</dt><dd>{detail.record.code || '未记录'}</dd><dt>日志编号</dt><dd>{detail.record.id}</dd><dt>操作编号</dt><dd>{detail.record.operationId || '未记录'}</dd></dl></details><pre aria-label="技术错误详情">{[detail.record.detail, detail.record.cause && `底层原因：\n${detail.record.cause}`, detail.record.stack].filter(Boolean).join('\n\n') || '此记录没有额外技术详情。'}</pre></section>}
        </div>
      </section>
      <label>问题描述（可选）<MarkdownEditor value={description} maxLength={2000} disabled={busy} onChange={event => setDescription(event.target.value)} placeholder="发生时间、操作步骤、实际现象"/></label>
      <details><summary>更多日志操作</summary><div className="logs-actions"><button disabled={busy} onClick={() => void exportKind('workflow')}>导出工作流分析包</button><button disabled={busy} onClick={() => void run(() => api.call('logs.cleanup', { kind: 'ordinary' }))}>清理普通日志</button></div></details>
      <details><summary>完整执行轨迹</summary><p>包含对话和工具执行内容。请选择已停止执行的会话，再单独导出或删除；对话和成果不会随轨迹删除。</p><div className="logs-actions"><button disabled={busy || !traceAllowed} onClick={() => void exportKind('trace')}>导出完整轨迹</button><button disabled={busy || !traceAllowed} onClick={() => void run(() => api.call('logs.cleanup', { kind: 'trace', sessionId }))}>删除所选轨迹</button></div></details>
      <p><small>工作流包附操作次数、成功/失败/取消及阶段耗时汇总。日志缺失和限流会在包内说明；应用未操作的时间不直接认定为低效。</small></p>
    </div><footer><button disabled={busy} onClick={() => void exportKind('diagnostic')}>导出故障报告</button><button disabled={busy} onClick={close}>{busy ? '处理中…' : '关闭'}</button></footer>
  </section></div>;
}
