import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Clock3, Edit3, FilePlus, LoaderCircle, Pause, Play, Plus, Trash2, X } from 'lucide-react';
import type { AgentSession, Project, ProviderCatalog, Snapshot, SourceFile, WorkbenchAPI } from '../shared/types';
import { activeScheduledRun, nextScheduledTime, scheduledStatus, scheduledLocalInput, scheduledInstant, type ScheduledRun, type ScheduledRunSession, type ScheduledSchedule, type ScheduledTask, type ScheduledTaskInput } from '../shared/scheduled-task';
import { PERSONAL_PROJECT_ID } from '../shared/personal-workspace';
import { sessionMessageText } from '../shared/session-context-text';
import { MarkdownEditor } from './markdown-editor';
import { ModelPicker } from './model-picker';
import { ProviderConnectionSettings } from './provider-connection';
import { PermissionPicker } from './permissions';
import type { ProviderConnectionCheck } from './provider-connection-check';
import { canUseProvider } from './provider-auth';
import { ConversationMessage } from './conversation-message';
import { SessionTranscript } from './session-transcript';
import { RequestCard } from './request-card';
import type { InheritedTranscript } from './transcript-pages';
import './scheduled-tasks.css';

const when = (value?: string, zone?: string) => value ? new Date(value).toLocaleString('zh-CN', zone ? { timeZone: zone } : undefined) : '—';
const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
function scheduleText(schedule: ScheduledSchedule) {
  if (schedule.kind === 'once') return '单次 · ' + when(schedule.at, schedule.timezone);
  if (schedule.kind === 'hourly') return `每隔 ${schedule.intervalHours} 小时`;
  return `${schedule.kind === 'daily' ? '每天' : schedule.kind === 'weekdays' ? '工作日' : '每周' + schedule.days.map(day => dayNames[day]).join('、')} ${schedule.time}`;
}

export function ScheduledTasksPage({ api, snapshot, projects, selectedProjectId, chooseProject, openSession, focusRun }: {
  api: WorkbenchAPI; snapshot: Snapshot; projects: Project[]; selectedProjectId: string; chooseProject: (id: string) => void;
  openSession: (session: AgentSession) => void; focusRun?: { id: string; projectId: string };
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]), [runs, setRuns] = useState<ScheduledRun[]>([]), [total, setTotal] = useState(0);
  const [projectId, setProjectId] = useState(selectedProjectId === PERSONAL_PROJECT_ID ? '' : selectedProjectId), [taskId, setTaskId] = useState('');
  const [editor, setEditor] = useState<{ task?: ScheduledTask }>(), [opened, setOpened] = useState<ScheduledRun>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<ScheduledTask>(), [deleteHistory, setDeleteHistory] = useState(false), [deleteRecords, setDeleteRecords] = useState(false);
  const [limit, setLimit] = useState(30);
  const sequence = useRef(0), mounted = useRef(true);
  const refresh = useCallback(async () => {
    const n = ++sequence.current;
    try {
      const [items, history] = await Promise.all([api.call<ScheduledTask[]>('scheduledTask.list'), Promise.all(Array.from({ length: Math.ceil(limit / 30) }, (_, index) => api.call<{ items: ScheduledRun[]; total: number }>('scheduledTask.runs', { projectId: projectId || undefined, taskId: taskId || undefined, limit: 30, offset: index * 30 }))).then(pages => ({ items: pages.flatMap(page => page.items), total: pages[0]?.total || 0 }))]);
      if (mounted.current && n === sequence.current) { setTasks(items); setRuns(history.items); setTotal(history.total); }
    } catch (e: any) { if (mounted.current && n === sequence.current) setError(e.message); }
  }, [projectId, taskId, limit, api]);
  useEffect(() => { mounted.current = true; void refresh(); let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.subscribe(event => { if (event.type === 'state' && !timer) timer = setTimeout(() => { timer = undefined; void refresh(); }, 350); });
    return () => { mounted.current = false; sequence.current++; clearTimeout(timer); unsubscribe(); };
  }, [refresh]);
  useEffect(() => { if (!focusRun) return; setProjectId(focusRun.projectId); setTaskId(''); if (!focusRun.id) { setOpened(undefined); return; } void api.call<ScheduledRunSession>('scheduledTask.open', { id: focusRun.id, projectId: focusRun.projectId }).then(value => setOpened(value.run), e => setError(e.message)); }, [focusRun]);
  const act = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); await refresh(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const visible = tasks.filter(task => !projectId || task.projectId === projectId);
  const currentRun = opened && (runs.find(run => run.id === opened.id) || opened);
  return <div className="workspace-page scheduled-page">
    <div className="page-title"><div><h1><Clock3 size={23}/>定时任务</h1><p className="muted small">在本机自动执行，关闭窗口后可留在托盘继续运行。</p></div><button className="primary" onClick={() => setEditor({})} disabled={!projects.some(project => project.id !== PERSONAL_PROJECT_ID)}><Plus size={16}/>新建定时任务</button></div>
    <div className="scheduled-filters"><label>项目<select aria-label="定时任务项目筛选" value={projectId} onChange={e => { setProjectId(e.target.value); setTaskId(''); setLimit(30); setOpened(undefined); setSelected([]); }}><option value="">全部项目</option>{projects.filter(project => project.id !== PERSONAL_PROJECT_ID).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><span className="muted small">任务使用本机缓存的项目资料，无需连接中央节点。</span></div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {currentRun ? <ScheduledRecord key={currentRun.id} run={currentRun} api={api} snapshot={snapshot} close={() => setOpened(undefined)} changed={refresh} continueSession={openSession}/> : <>
      <div className="scheduled-task-list">{visible.map(task => <section className="scheduled-card" key={task.id}>
        <div className="scheduled-card-heading"><div><h2>{task.name}</h2><span className="muted small">{task.projectName} · {scheduleText(task.schedule)} · {task.schedule.timezone}</span></div><span className="spacer"/><span className="scheduled-state">{task.paused ? '已暂停' : task.activeRun ? scheduledStatus[task.activeRun.status] : task.nextRunAt ? '已启用' : '计划已结束'}</span></div>
        <p className="scheduled-task-prompt">{task.prompt}</p><p className="muted small">下次执行：{task.paused ? '暂停中' : when(task.nextRunAt, task.schedule.timezone)}</p>
        <div className="row"><button className="secondary compact" disabled={busy || !!task.activeRun} onClick={() => void act(() => api.call('scheduledTask.runNow', { id: task.id, projectId: task.projectId }))}><Play size={14}/>立即执行</button><button className="text-button" disabled={busy} onClick={() => void act(() => api.call('scheduledTask.pause', { id: task.id, projectId: task.projectId, paused: !task.paused }))}>{task.paused ? <Play size={14}/> : <Pause size={14}/>}{task.paused ? '恢复' : '暂停'}</button><button className="text-button" onClick={() => setEditor({ task })}><Edit3 size={14}/>编辑</button><button className="text-button" onClick={() => { setTaskId(task.id); setLimit(30); }}>运行记录</button><span className="spacer"/><button className="icon" aria-label={'删除定时任务：' + task.name} onClick={() => { setDeleting(task); setDeleteHistory(false); }}><Trash2 size={15}/></button></div>
      </section>)}</div>
      {!visible.length && <div className="scheduled-empty"><Clock3 size={32}/><p>还没有定时任务。先选择项目，再设置任务和执行时间。</p></div>}
      <div className="scheduled-history-heading"><h2>运行记录{taskId && ' · ' + (tasks.find(task => task.id === taskId)?.name || '已删除任务')}</h2>{taskId && <button className="text-button" onClick={() => { setTaskId(''); setSelected([]); }}>查看全部</button>}<span className="spacer"/><span className="muted small">共 {total} 次</span><button className="secondary compact" disabled={!selected.length || busy} onClick={() => setDeleteRecords(true)}>删除所选（{selected.length}）</button></div>
      <div className="scheduled-run-list">{runs.map(run => <div className="scheduled-run" key={run.id}>
        <input type="checkbox" aria-label={'选择运行记录：' + run.id} disabled={activeScheduledRun(run)} checked={selected.includes(run.id)} onChange={e => setSelected(value => e.target.checked ? [...value, run.id] : value.filter(id => id !== run.id))}/>
        <button className="scheduled-run-entry" onClick={() => { setOpened(run); setError(''); }}><b>{run.taskName}</b><span className="muted small">{run.projectName} · {when(run.scheduledAt)}{run.manual ? ' · 手动执行' : ''}</span><span className="scheduled-run-summary">{run.error || run.summary || (run.status === 'waiting' ? '需要你回答问题或批准操作' : '查看执行会话')}</span></button>
        <span className={'scheduled-state ' + (['failed', 'interrupted'].includes(run.status) ? 'failed' : '')}>{['running', 'queued'].includes(run.status) && <LoaderCircle size={13} className="spin"/>}{scheduledStatus[run.status]}</span>
        {activeScheduledRun(run) && <button className="text-button" disabled={busy} onClick={() => void act(() => api.call('scheduledTask.stop', { id: run.id, projectId: run.projectId }))}>停止</button>}
      </div>)}{!runs.length && <p className="muted small">暂无运行记录。</p>}</div>
      {runs.length < total && <button className="secondary" onClick={() => setLimit(value => value + 30)}>加载更多记录</button>}
    </>}
    {editor && <TaskEditor task={editor.task} api={api} snapshot={snapshot} projects={projects.filter(project => project.id !== PERSONAL_PROJECT_ID)} chooseProject={chooseProject} close={() => setEditor(undefined)} saved={id => { setEditor(undefined); setProjectId(id); setTaskId(''); void refresh(); }}/ >}
    {deleting && <TaskDialog title="删除定时任务" close={() => setDeleting(undefined)}><div className="modal-body"><p>删除“{deleting.name}”后，不再触发后续执行。当前执行可单独停止。</p><label className="check-row"><input type="checkbox" checked={deleteHistory} onChange={e => setDeleteHistory(e.target.checked)}/>同时删除历史运行记录（已加入工作会话的对话保留）</label></div><footer><button className="secondary" onClick={() => setDeleting(undefined)}>取消</button><button className="danger" disabled={busy} onClick={() => void act(async () => { await api.call('scheduledTask.delete', { id: deleting.id, projectId: deleting.projectId, deleteHistory }); setDeleting(undefined); })}>删除任务</button></footer></TaskDialog>}
    {deleteRecords && <TaskDialog title="删除运行记录" close={() => setDeleteRecords(false)}><div className="modal-body"><p>删除所选 {selected.length} 条历史记录？已加入普通工作会话的对话会保留。</p></div><footer><button className="secondary" onClick={() => setDeleteRecords(false)}>取消</button><button className="danger" disabled={busy} onClick={() => void act(async () => { for (const group of new Set(runs.filter(run => selected.includes(run.id)).map(run => run.projectId))) await api.call('scheduledTask.deleteRuns', { projectId: group, ids: runs.filter(run => run.projectId === group && selected.includes(run.id)).map(run => run.id) }); setSelected([]); setDeleteRecords(false); })}>删除记录</button></footer></TaskDialog>}
  </div>;
}

function TaskDialog({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  const root = useRef<HTMLElement>(null), prior = useRef<Element | null>(null);
  useEffect(() => { prior.current = document.activeElement; root.current?.focus(); return () => { (prior.current as HTMLElement)?.focus?.(); }; }, []);
  return <div className="overlay"><section ref={root} className="modal wide scheduled-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing && !((event.target instanceof HTMLSelectElement) && event.target.matches(':open'))) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab' || (event.target as HTMLElement).tagName === 'TEXTAREA') return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)') || [])].filter(item => item.getClientRects().length);
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
  }}><header><h2>{title}</h2><button className="icon" aria-label="关闭定时任务窗口" onClick={close}><X size={18}/></button></header>{children}</section></div>;
}

function TaskEditor({ task, api, snapshot, projects, chooseProject, close, saved }: { task?: ScheduledTask; api: WorkbenchAPI; snapshot: Snapshot; projects: Project[]; chooseProject: (id: string) => void; close: () => void; saved: (projectId: string) => void }) {
  const [projectId, setProjectId] = useState(task?.projectId || ''), [step, setStep] = useState(task ? 2 : 1);
  const [name, setName] = useState(task?.name || ''), [prompt, setPrompt] = useState(task?.prompt || ''), [supplement, setSupplement] = useState(task?.supplement || '');
  const [sources, setSources] = useState(task?.sources || []), [includeBrief, setIncludeBrief] = useState(task?.includeBrief ?? true);
  const [schedule, setSchedule] = useState<ScheduledSchedule>(task?.schedule || { kind: 'daily', time: '09:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const [model, setModel] = useState(task?.model || ''), [reasoningEffort, setReasoningEffort] = useState(task?.reasoningEffort), [permissionMode, setPermissionMode] = useState(task?.permissionMode || 'inherit'), [networkRoute, setNetworkRoute] = useState(task?.networkRoute || 'direct');
  const [location, setLocation] = useState<{ cwd: string; followsDirectory: boolean }>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [networkBusy, setNetworkBusy] = useState(false), [networkPending, setNetworkPending] = useState(false);
  const [check, setCheck] = useState<ProviderConnectionCheck>(), [catalog, setCatalog] = useState<ProviderCatalog>();
  const scoped = useMemo<WorkbenchAPI>(() => ({ ...api, call: <T,>(action: string, payload?: unknown) => api.call<T>(action, typeof payload === 'string' ? payload : { ...(payload as object || {}), projectId }) }), [api, projectId]);
  useEffect(() => { if (!projectId || step !== 2) return; let live = true; setLocation(undefined); chooseProject(projectId); void scoped.call<{ cwd: string; followsDirectory: boolean }>('scheduledTask.location', { projectId }).then(value => { if (live) setLocation(value); }, e => { if (live) setError(e.message); }); return () => { live = false; }; }, [projectId, step]);
  const profile = snapshot.personal?.settings.workspaceSnapshot?.profile;
  const environment = profile?.projects.some(project => project.id === projectId) ? snapshot.personal! : snapshot;
  const selectedModel = catalog?.models.find(item => item.id === (model || catalog.defaultModel));
  const next = nextScheduledTime(schedule, Date.now());
  const save = async () => {
    setBusy(true); setError('');
    try { const input: ScheduledTaskInput = { projectId, name, prompt, supplement, schedule, model, reasoningEffort, permissionMode, networkRoute, includeBrief, sourceIds: sources.map(source => source.id) }; await scoped.call('scheduledTask.save', { id: task?.id, input }); saved(projectId); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const chooseKind = (kind: ScheduledSchedule['kind']) => {
    const timezone = schedule.timezone;
    if (kind === 'once') setSchedule({ kind, timezone, at: new Date(Date.now() + 3600000).toISOString() });
    else if (kind === 'hourly') setSchedule({ kind, timezone, intervalHours: 1, anchor: new Date().toISOString() });
    else setSchedule(kind === 'weekly' ? { kind, timezone, time: 'time' in schedule ? schedule.time : '09:00', days: [1] } : { kind, timezone, time: 'time' in schedule ? schedule.time : '09:00' });
  };
  return <TaskDialog title={task ? '编辑定时任务' : step === 1 ? '新建定时任务 · 选择项目' : '新建定时任务'} close={() => { if (!busy) close(); }}>
    <div className="modal-body">{error && <div className="inline-error" role="alert">{error}</div>}
      {step === 1 ? <><p>选择任务所属项目。每次执行都会带入该项目最新的本地资料。</p><label className="field">项目<select autoFocus aria-label="新建定时任务所属项目" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">请选择项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></> : <>
        <p className="muted small">所属项目：{projects.find(project => project.id === projectId)?.name || task?.projectName} · Codex</p>
        <label className="field">任务名称<input autoFocus aria-label="定时任务名称" maxLength={120} value={name} onChange={event => setName(event.target.value)}/></label>
        <label className="field">任务说明<MarkdownEditor aria-label="定时任务说明" rows={5} maxLength={64000} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述每次需要完成的工作和输出要求，支持 Markdown"/></label>
        <div className="scheduled-schedule-fields"><label className="field">执行频率<select aria-label="执行频率" value={schedule.kind} onChange={event => chooseKind(event.target.value as ScheduledSchedule['kind'])}><option value="once">单次</option><option value="hourly">每隔若干小时</option><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周</option></select></label>
          {schedule.kind === 'once' ? <label className="field">执行时间<input type="datetime-local" aria-label="单次执行时间" value={scheduledLocalInput(schedule.at, schedule.timezone)} onChange={event => { const at = scheduledInstant(event.target.value, schedule.timezone); if (at) { setSchedule({ ...schedule, at }); setError(''); } else setError('该时区不存在此时间，请重新选择'); }}/></label> : schedule.kind === 'hourly' ? <label className="field">间隔小时<input type="number" aria-label="间隔小时" min={1} max={8760} value={schedule.intervalHours} onChange={event => setSchedule({ ...schedule, intervalHours: Math.max(1, Number(event.target.value)) })}/></label> : <label className="field">执行时间<input type="time" aria-label="每日执行时间" value={schedule.time} onChange={event => { if (event.target.value) setSchedule({ ...schedule, time: event.target.value }); }}/></label>}
        </div>
        {schedule.kind === 'weekly' && <fieldset className="scheduled-days"><legend>执行日期</legend>{dayNames.map((name, day) => <label key={day}><input type="checkbox" checked={schedule.days.includes(day)} onChange={event => setSchedule({ ...schedule, days: event.target.checked ? [...schedule.days, day].sort() : schedule.days.filter(value => value !== day) })}/>周{name}</label>)}</fieldset>}
        <p className="muted small">时区：{schedule.timezone} · 下次执行：{when(next, schedule.timezone)}</p>
        <label className="check-row"><input type="checkbox" checked={includeBrief} onChange={event => setIncludeBrief(event.target.checked)}/>默认引用项目资料，每次使用最新本地版本</label>
        <label className="field">本任务补充资料<MarkdownEditor aria-label="定时任务补充资料" rows={4} maxLength={64000} value={supplement} onChange={event => setSupplement(event.target.value)} placeholder="只提供给本任务，不修改项目公共资料"/></label>
        <div className="scheduled-attachments">{sources.map(source => <div className="row" key={source.id}><span>{source.name}</span><button className="icon" aria-label={'移除任务附件：' + source.name} onClick={() => setSources(value => value.filter(item => item.id !== source.id))}><X size={14}/></button></div>)}<button className="secondary compact" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { const files = await scoped.call<SourceFile[]>('scheduledTask.pickAttachments'); setSources(value => [...value, ...files]); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}><FilePlus size={14}/>添加参考文件</button></div>
        <p className="muted small break">工作目录：{task && !task.followsDirectory ? task.cwd : location?.followsDirectory ? location.cwd : '未配置项目目录，任务将使用固定独立目录'}</p>
        {location && <><div className="new-session-grid"><ProviderConnectionSettings api={scoped} provider="codex" cwd={location.cwd} auth={environment.auth.codex} egress={environment.egress} activeTaskCount={snapshot.sessions.filter(session => ['starting', 'running', 'approval'].includes(session.status)).length} busyChanged={setNetworkBusy} pendingChanged={setNetworkPending} checked={setCheck} showCatalog={false} sessionRoute={networkRoute} routeChanged={route => { setNetworkRoute(route); setCheck(undefined); setCatalog(undefined); }}/><ModelPicker api={scoped} provider="codex" cwd={location.cwd} networkRoute={networkRoute} ready={!networkBusy && !networkPending && !!canUseProvider(check?.auth)} model={model} changed={value => { setModel(value); setReasoningEffort(undefined); }} initialCatalog={check?.catalog} catalogChanged={setCatalog}/></div>
          <label className="field">思考程度<select aria-label="定时任务思考程度" value={reasoningEffort || ''} onChange={event => setReasoningEffort(event.target.value || undefined)}><option value="">默认</option>{reasoningEffort && !selectedModel?.reasoningEfforts?.some(option => option.id === reasoningEffort) && <option value={reasoningEffort}>{reasoningEffort}</option>}{(selectedModel?.reasoningEfforts || [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }]).map(option => <option key={option.id} value={option.id}>{option.id}</option>)}</select></label>
          <PermissionPicker api={scoped} provider="codex" cwd={location.cwd} networkRoute={networkRoute} mode={permissionMode} changed={setPermissionMode}/></>}
        <p className="muted small">每次新建会话，历史收进运行记录；需要授权时等待你处理。退出工作台或电脑休眠期间不执行，恢复后不补跑错过的计划。</p>
      </>}
    </div><footer>{step === 2 && !task && <button className="text-button" disabled={busy} onClick={() => setStep(1)}>重新选择项目</button>}<span className="spacer"/><button className="secondary" disabled={busy} onClick={close}>取消</button>{step === 1 ? <button className="primary" disabled={!projectId} onClick={() => setStep(2)}>下一步</button> : <button className="primary" disabled={busy || networkPending || networkBusy || !location || !name.trim() || !prompt.trim() || !next} onClick={() => void save()}>{busy ? '保存中…' : '保存定时任务'}</button>}</footer>
  </TaskDialog>;
}

function ScheduledRecord({ run, api, snapshot, close, changed, continueSession }: { run: ScheduledRun; api: WorkbenchAPI; snapshot: Snapshot; close: () => void; changed: () => Promise<void>; continueSession: (session: AgentSession) => void }) {
  const [record, setRecord] = useState<ScheduledRunSession>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; void api.call<ScheduledRunSession>('scheduledTask.open', { id: run.id, projectId: run.projectId }).then(value => { if (active) { setRecord(value); setError(''); } }, e => { if (active) setError(e.message); }); return () => { active = false; }; }, [run.id, run.status]);
  const session = snapshot.sessions.find(session => session.id === run.sessionId) || record?.session;
  const scroller = useRef<HTMLDivElement>(null), following = useRef(true);
  useLayoutEffect(() => { if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [session?.messages.length, session?.messages.at(-1)?.text]);
  const inherited = useMemo<InheritedTranscript | undefined>(() => record?.earlierCount ? { count: record.earlierCount, label: '以上为本次任务的更早消息', read: (before, limit) => api.call('scheduledTask.historyPage', { id: run.id, projectId: run.projectId, before, limit }) } : undefined, [record?.earlierCount, run.id, api]);
  const act = async (job: () => Promise<unknown>) => { setBusy(true); setError(''); try { await job(); await changed(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return <section className="scheduled-record"><div className="scheduled-history-heading"><button className="icon" aria-label="返回定时任务运行记录" onClick={close}><ArrowLeft size={18}/></button><div><h2>{run.taskName}</h2><span className="muted small">{when(run.scheduledAt)} · {scheduledStatus[run.status]}{run.context?.briefRevision !== undefined ? ` · 项目资料 v${run.context.briefRevision}` : ''}</span></div><span className="spacer"/>{activeScheduledRun(run) ? <button className="secondary" disabled={busy} onClick={() => void act(() => api.call('scheduledTask.stop', { id: run.id, projectId: run.projectId }))}>停止本次执行</button> : session && <button className="primary" disabled={busy} onClick={() => void act(async () => { const value = await api.call<AgentSession>('scheduledTask.continue', { id: run.id, projectId: run.projectId }); continueSession(value); })}>继续对话</button>}</div>
    {(error || run.error) && <div className="inline-error" role="alert">{error || run.error}</div>}
    <div className="scheduled-record-messages" data-transcript-scroll tabIndex={0} ref={scroller} onScroll={() => { const element = scroller.current; if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>{session ? <><SessionTranscript key={session.id + ':' + (record?.earlierCount || 0)} session={session} inherited={inherited} renderMessage={message => <ConversationMessage key={message.id} message={message} provider="codex" text={sessionMessageText(session, message)} sessionId={session.id}/>}/>{activeScheduledRun(run) && session.approvals.map(request => <RequestCard key={request.id} request={request} onAnswer={(option, answers) => void act(() => api.call('session.answer', { id: session.id, projectId: run.projectId, requestId: request.id, option, answers }))}/>)}</> : !error && <p className="muted">正在读取会话…</p>}</div>
  </section>;
}
