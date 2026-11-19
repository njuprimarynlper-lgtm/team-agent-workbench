import { collaborationFailure } from './collaboration-failure';
import { uiErrorMessage } from '../shared/user-failure';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, FilePlus2, Folder, FolderPlus, Plus } from 'lucide-react';
import { usePopupDismiss } from './popup-dismiss';
import { resultDirectoryLabel, resultDirectoryNodes, resultDirectoryPath, resultItemFolder, resolveResultFolder, type ResultDirectory, type ResultDirectoryCommand } from '../shared/result-directories';
import { cachedTeamRead } from './team-cache';
import './result-directories.css';

type Scope = 'personal' | 'team';
const api = window.workbench;
const changedEvent = 'result-directories-changed';
export function useResultDirectories(projectId: string, scope: Scope) {
  const [directories, setDirectories] = useState<ResultDirectory[]>([]), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  const sequence = useRef(0);
  const active = useRef(''); active.current = scope + ':' + projectId;
  const load = async () => {
    const request = ++sequence.current;
    const apply = (value: ResultDirectory[] | undefined) => { if (value !== undefined && !Array.isArray(value)) throw new Error('成果目录数据无效，请刷新或更新中央节点'); if (sequence.current === request) { setDirectories(value || []); setLoaded(value !== undefined); } };
    try {
      if (scope === 'team') await cachedTeamRead<ResultDirectory[]>(api, { action: 'result.directory.list', projectId }, apply, () => api.call('result.directory.list', { projectId, scope }));
      else apply(await api.call('result.directory.list', { projectId, scope }));
      if (sequence.current === request) setError('');
    } catch (reason: any) { if (sequence.current === request) setError(reason.message); }
  };
  useEffect(() => {
    setDirectories([]); setLoaded(false); setError(''); void load();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { clearTimeout(pending); pending = setTimeout(() => void load(), 180); };
    const unsubscribe = scope === 'personal' ? api.subscribe(event => { if (event.type === 'state') refresh(); }) : () => {};
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30000);
    window.addEventListener(changedEvent, refresh);
    return () => { ++sequence.current; clearTimeout(pending); clearInterval(interval); unsubscribe(); window.removeEventListener(changedEvent, refresh); };
  }, [projectId, scope]);
  const change = async (command: ResultDirectoryCommand) => {
    const context = active.current;
    const next = await api.call<ResultDirectory[]>('result.directory.change', { projectId, scope, command });
    if (active.current !== context) throw new Error('项目已切换，原项目的目录操作已完成');
    ++sequence.current; setDirectories(next); setLoaded(true); setError(''); window.dispatchEvent(new Event(changedEvent)); return next;
  };
  return { scope, directories, loaded, error, load, change };
}
type DirectoryState = ReturnType<typeof useResultDirectories>;

export async function moveResultDestinations(projectId: string, scope: Scope, items: { id: string; title?: string; version: number; folderVersion?: number }[], folders: Record<string, string>, directories: ResultDirectory[] = []) {
  const groups = new Map<string, typeof items>();
  for (const item of items) groups.set(folders[item.id], [...(groups.get(folders[item.id]) || []), item]);
  const completed: { description: string; count: number }[] = [];
  const short = (value: string, limit: number) => value.length > limit ? value.slice(0, limit) + '…' : value;
  const names = (entries: typeof items) => entries.slice(0, 2).map(item => `“${short(item.title || '所选成果', 30)}”`).join('、') + (entries.length > 2 ? `等${entries.length}条成果` : '');
  for (const [folderId, entries] of groups) {
    const destination = short(resultDirectoryLabel(folderId, directories), 40);
    try {
      await api.call('result.directory.move', { projectId, scope, change: { folderId, items: entries.map(({ id, version, folderVersion }) => ({ id, version, folderVersion: folderVersion || 0 })) } });
      completed.push({description:`${names(entries)}已移到“${destination}”`,count:entries.length});
    } catch (reason: any) {
      const message = (completed.length ? completed[0].description + '。' + (completed.length > 1 ? `另外${completed.slice(1).reduce((total,item)=>total+item.count,0)}条成果也已移动。` : '') : '') + `${names(entries)}移到“${destination}”的结果还没查到。点“刷新”后打开“${destination}”：已在里面就不用再移。`;
      throw new Error(collaborationFailure(reason, message, { domain: scope === 'team' ? 'central' : 'local', operation: '移动成果目录', outcome: completed.length ? 'partial' : 'unknown' }));
    }
  }
}

export function DirectoryTree({ directories, value, change, all, counts = {}, disabled = false, actions, reveal }: { directories: ResultDirectory[]; value: string; change: (id: string) => void; all?: boolean; counts?: Record<string, number>; disabled?: boolean; actions?: (id: string) => React.ReactNode; reveal?: string }) {
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  useEffect(() => { if (reveal) setExpandedIds(current => [...new Set([...current, ...resultDirectoryPath(reveal, directories).slice(0, -1).map(node => node.id)])]); }, [reveal]);
  const nodes = resultDirectoryNodes(directories);
  const toggle = (id: string) => setExpandedIds(current => {
    if (!current.includes(id)) return [...current, id];
    return current.filter(candidate => !resultDirectoryPath(candidate, directories).some(node => node.id === id));
  });
  const branch = (parent: string | null, depth = 0, seen = new Set<string>()): React.ReactNode => depth < 32 && nodes.filter(node => node.parentId === parent && !seen.has(node.id)).map(node => {
    const children = nodes.some(child => child.parentId === node.id), expanded = expandedIds.includes(node.id);
    return <li key={node.id}><div className={'result-directory-row' + (value === node.id ? ' is-selected' : '')} style={{ paddingLeft: 8 + depth * 14 }}>
      {children ? <button type="button" className="result-directory-chevron" aria-label={`${expanded ? '收起' : '展开'}目录：${node.name}`} aria-expanded={expanded} onClick={() => toggle(node.id)}>{expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button> : <span className="result-directory-chevron"/>}
      <button type="button" className="result-directory-name" title={resultDirectoryLabel(node.id, directories)} aria-current={value === node.id ? 'page' : undefined} disabled={disabled} onClick={() => change(node.id)}><Folder size={14}/><span>{node.name}</span>{counts[node.id] !== undefined && <small>{counts[node.id]}</small>}</button>
      {value === node.id && actions?.(node.id)}
    </div>{children && expanded && <ul>{branch(node.id, depth + 1, new Set([...seen, node.id]))}</ul>}</li>;
  });
  return <nav className="result-directory-tree" aria-label="成果目录">{all && <button type="button" className={'result-directory-all' + (value === 'all' ? ' is-selected' : '')} disabled={disabled} onClick={() => change('all')}>全部目录</button>}<ul>{branch(null)}</ul></nav>;
}

function DirectoryManagement({ state, value, select, manage = true, disabled = false, all, counts, createResult, resultDisabled = false }: { state: DirectoryState; value: string; select: (id: string) => void; manage?: boolean; disabled?: boolean; all?: boolean; counts?: Record<string, number>; createResult?: (folderId: string) => void; resultDisabled?: boolean }) {
  const [action, setAction] = useState<'create' | 'rename' | 'delete'>(), [name, setName] = useState(''), [parentId, setParentId] = useState('exploration'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [target, setTarget] = useState<ResultDirectory>();
  const [reveal, setReveal] = useState('');
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null), createId = useRef('');
  const directory = state.directories.find(item => item.id === value && !item.deletedAt);
  const location = (id: string) => `${state.scope === 'personal' ? '个人成果库' : '团队成果库'} / ${resultDirectoryLabel(id, state.directories)}`;
  const [parentLabel, setParentLabel] = useState('');
  usePopupDismiss(open, popup, reason => { setOpen(false); if (reason === 'escape') trigger.current?.focus(); }, { inside: () => [trigger.current], owner: () => trigger.current });
  useEffect(() => { setOpen(false); }, [value, state.scope, disabled]);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !popup.current) return;
    const rect = trigger.current.getBoundingClientRect(), row = trigger.current.closest('.result-directory-row')?.getBoundingClientRect() || rect, panel = popup.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(row.left, window.innerWidth - panel.width - 8)), top: rect.bottom + 6 + panel.height <= window.innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - panel.height - 6) });
    const dismiss = (event: Event) => { if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) setOpen(false); };
    window.addEventListener('resize', dismiss); document.addEventListener('scroll', dismiss, true);
    return () => { window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', dismiss, true); };
  }, [open]);
  const close = () => { if (!busy) setAction(undefined); };
  useEffect(() => { if (!action) return; const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopImmediatePropagation(); if (!busy) setAction(undefined); } }; document.addEventListener('keydown', escape, true); return () => document.removeEventListener('keydown', escape, true); }, [action, busy]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const id = action === 'create' ? createId.current : target!.id;
      const command: ResultDirectoryCommand = action === 'create' ? { action, id, parentId, name } : action === 'rename' ? { action, id, revision: target!.revision, name } : { action: 'delete', id, revision: target!.revision };
      const next = await state.change(command); select(action === 'delete' ? resolveResultFolder(id, next) : id); if (action === 'create') setReveal(id); setAction(undefined);
    } catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
  };
  return <><DirectoryTree directories={state.directories} value={value} change={select} all={all} counts={counts} disabled={disabled} reveal={reveal} actions={id => <button ref={trigger} type="button" className="result-directory-add icon" aria-label={`在“${resultDirectoryLabel(id, state.directories)}”中新建`} title="在此文件夹中新建" aria-haspopup="menu" aria-expanded={open} disabled={disabled || !state.loaded} onClick={() => setOpen(current => !current)}><Plus size={15}/></button>}/>
    {manage && directory && <div className="result-directory-management"><button type="button" className="text-button" disabled={disabled} onClick={() => { setTarget({ ...directory }); setName(directory.name); setError(''); setAction('rename'); }}>重命名</button><button type="button" className="text-button danger" disabled={disabled} onClick={() => { setTarget({ ...directory }); setError(''); setAction('delete'); }}>删除目录</button></div>}
    {open && createPortal(<div ref={popup} className="result-directory-add-menu" role="menu" aria-label="在此文件夹中新建" style={position}>
      <div className="result-directory-menu-location">{location(value)}</div>
      <button type="button" role="menuitem" onClick={() => { const id = resolveResultFolder(value, state.directories); createId.current = crypto.randomUUID(); setParentId(id); setParentLabel(location(id)); setName(''); setError(''); setOpen(false); setAction('create'); }}><FolderPlus size={15}/>新建子文件夹</button>
      {createResult && <button type="button" role="menuitem" disabled={resultDisabled} onClick={() => { setOpen(false); createResult(value); }}><FilePlus2 size={15}/>新建成果</button>}
    </div>, document.body)}
    {action && createPortal(<div className="modal-backdrop result-directory-modal" onMouseDown={event => { if (event.target === event.currentTarget) { event.stopPropagation(); close(); } }}><section className="modal" role="dialog" aria-modal="true" aria-label={action === 'create' ? '新建子文件夹' : action === 'rename' ? '重命名目录' : '删除目录'}>
    <header><h2>{action === 'create' ? '新建子文件夹' : action === 'rename' ? '重命名目录' : '删除目录'}</h2><button type="button" className="icon" disabled={busy} aria-label="关闭目录窗口" onClick={close}>×</button></header>
    <div className="modal-body">{action === 'delete' ? <p>删除“{target?.name}”后，其中的成果和子目录会移到上一级，内容会保留。</p> : <>{action === 'create' && <div className="field"><span>保存位置</span><div className="result-directory-location" aria-label="上级文件夹"><Folder size={15}/><span>{parentLabel}</span></div></div>}<label className="field">{action === 'create' ? '文件夹名称' : '目录名称'}<input autoFocus aria-label={action === 'create' ? '文件夹名称' : '目录名称'} value={name} maxLength={60} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && name.trim() && !busy) void save(); }}/></label></>}{error && <div className="inline-error" role="alert">{error}</div>}</div>
    <footer><button type="button" className="secondary" disabled={busy} onClick={close}>取消</button><button type="button" className={action === 'delete' ? 'primary danger' : 'primary'} disabled={busy || action !== 'delete' && !name.trim()} onClick={() => void save()}>{busy ? '正在保存…' : action === 'delete' ? '删除目录，保留内容' : action === 'create' ? '创建子文件夹' : '保存目录'}</button></footer>
  </section></div>, document.body)}</>;
}

export function ResultDirectorySidebar({ state, value, change, items, manage = true, disabled = false, createResult, resultDisabled }: { state: DirectoryState; value: string; change: (id: string) => void; items: { folderId?: string; title: string; category?: string; kind?: string }[]; manage?: boolean; disabled?: boolean; createResult?: (folderId: string) => void; resultDisabled?: boolean }) {
  const counts: Record<string, number> = {};
  for (const item of items) for (const node of resultDirectoryPath(resultItemFolder(item, state.directories), state.directories)) counts[node.id] = (counts[node.id] || 0) + 1;
  useEffect(() => { if (state.loaded && value !== 'all') { const resolved = resolveResultFolder(value, state.directories); if (resolved !== value) change(resolved); } }, [value, state.directories, state.loaded]);
  return <aside className="result-directory-sidebar"><div className="result-directory-heading"><b>目录</b><span className="muted small">成果数含子目录</span></div><DirectoryManagement state={state} value={value} select={change} all counts={counts} manage={manage} disabled={disabled} createResult={createResult} resultDisabled={resultDisabled}/>{state.error && <p className="small directory-error" role="status">目录暂未更新：{state.error}<button type="button" className="text-button" onClick={() => void state.load()}>刷新目录</button></p>}</aside>;
}

interface DestinationItem { id: string; title: string; category?: string; folderId?: string; kind?: string }
interface DestinationRequest { scope: Scope; title?: string; items: DestinationItem[]; details?: React.ReactNode; confirmLabel?: string; updateContent?: { label: string; confirmLabel: string; change: (checked: boolean) => void } }
export function ResultDirectoryBreadcrumb({ id, directories }: { id: string; directories: ResultDirectory[] }) {
  return <span className="result-path-crumbs">{resultDirectoryPath(id, directories).map((node, index) => <React.Fragment key={node.id}>{index > 0 && <ChevronRight size={12} aria-hidden="true"/>}<span>{node.name}</span></React.Fragment>)}</span>;
}
function DestinationDialog({ projectId, request, finish }: { projectId: string; request: DestinationRequest; finish: (value?: Record<string, string>) => void }) {
  const state = useResultDirectories(projectId, request.scope);
  const [folders, setFolders] = useState<Record<string, string>>({}), [selected, setSelected] = useState(request.items[0].id);
  const [updateContent, setUpdateContent] = useState(false);
  const selectedItem = request.items.find(item => item.id === selected)!;
  const folder = (item: DestinationItem) => folders[item.id] || resultItemFolder(item, state.directories);
  // Resolve original locations only once the directory snapshot has arrived.
  const current = folder(selectedItem);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('.result-directory-modal, .result-directory-add-menu')) { event.stopImmediatePropagation(); finish(); } }; document.addEventListener('keydown', escape, true); return () => document.removeEventListener('keydown', escape, true); }, []);
  return <div className="modal-backdrop result-destination-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) finish(); }}><section className="modal result-destination-modal" role="dialog" aria-modal="true" aria-label="选择成果保存目录">
    <header><h2>{request.title || `选择${request.scope === 'personal' ? '个人' : '团队'}目录`}</h2><button type="button" className="icon" aria-label="取消选择目录" onClick={() => finish()}>×</button></header>
    <div className="modal-body"><p className="result-destination-subject">{selectedItem.title}</p><div className="result-destination-current"><span>当前位置</span><ResultDirectoryBreadcrumb id={resultItemFolder(selectedItem, state.directories)} directories={state.directories}/></div>
      {state.error && <div className="inline-error" role="alert">{state.error}<button type="button" className="text-button" onClick={() => void state.load()}>刷新目录</button></div>}
      <div className={'result-destination-grid' + (request.items.length === 1 ? ' is-single' : '')}>{request.items.length > 1 && <div className="result-destination-items" aria-label="选择需要指定目录的成果">{request.items.map(item => <button type="button" key={item.id} className={selected === item.id ? 'is-selected' : ''} onClick={() => setSelected(item.id)}><b>{item.title}</b><small>{state.loaded ? resultDirectoryPath(folder(item), state.directories).at(-1)?.name : '正在读取目录…'}</small></button>)}</div>}
        <div><DirectoryManagement state={state} value={current} select={id => setFolders(previous => ({ ...previous, [selected]: id }))} disabled={!state.loaded} manage={false}/></div>
      </div><div className="result-destination-selected" role="status"><span>目标{request.scope === 'personal' ? '个人' : '团队'}目录</span><ResultDirectoryBreadcrumb id={current} directories={state.directories}/></div>{request.items.length > 1 && <button type="button" className="text-button" disabled={!state.loaded} onClick={() => setFolders(Object.fromEntries(request.items.map(item => [item.id, current])))}>全部保存到当前选中的目录</button>}{request.updateContent && <label className="check-row result-destination-update"><input type="checkbox" checked={updateContent} onChange={event => { setUpdateContent(event.target.checked); request.updateContent!.change(event.target.checked); }}/>{request.updateContent.label}</label>}{request.details}
    </div><footer><button type="button" className="secondary" onClick={() => finish()}>取消</button><button type="button" className="primary" disabled={!state.loaded} onClick={() => finish(Object.fromEntries(request.items.map(item => [item.id, folder(item)])))}>{updateContent ? request.updateContent!.confirmLabel : request.confirmLabel || '确认目录并继续'}</button></footer>
  </section></div>;
}

export function useResultDestination(projectId: string) {
  const [request, setRequest] = useState<DestinationRequest>();
  const pending = useRef<((value?: Record<string, string>) => void) | undefined>(undefined);
  const finish = (value?: Record<string, string>) => { const resolve = pending.current; pending.current = undefined; setRequest(undefined); resolve?.(value); };
  useEffect(() => { setRequest(undefined); return () => { pending.current?.(); pending.current = undefined; }; }, [projectId]);
  const choose = (value: DestinationRequest) => { pending.current?.(); if (!value.items.length) return Promise.resolve(undefined); setRequest(value); return new Promise<Record<string, string> | undefined>(resolve => { pending.current = resolve; }); };
  return { choose, dialog: request && <DestinationDialog key={projectId + request.scope} projectId={projectId} request={request} finish={finish}/> };
}
