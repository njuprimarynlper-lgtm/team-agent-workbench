import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderPlus } from 'lucide-react';
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
  return { directories, loaded, error, load, change };
}
type DirectoryState = ReturnType<typeof useResultDirectories>;

export async function moveResultDestinations(projectId: string, scope: Scope, items: { id: string; version: number; folderVersion?: number }[], folders: Record<string, string>) {
  const groups = new Map<string, typeof items>();
  for (const item of items) groups.set(folders[item.id], [...(groups.get(folders[item.id]) || []), item]);
  let moved = 0;
  try {
    for (const [folderId, entries] of groups) {
      await api.call('result.directory.move', { projectId, scope, change: { folderId, items: entries.map(item => ({ ...item, folderVersion: item.folderVersion || 0 })) } });
      moved += entries.length;
    }
  } catch (reason: any) { throw new Error((moved ? `已移动 ${moved} 条，其余未完成。` : '') + reason.message); }
}

export function DirectoryTree({ directories, value, change, all, counts = {}, disabled = false }: { directories: ResultDirectory[]; value: string; change: (id: string) => void; all?: boolean; counts?: Record<string, number>; disabled?: boolean }) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  useEffect(() => { const ancestors = resultDirectoryPath(value, directories).map(item => item.id); setCollapsed(current => current.filter(id => !ancestors.includes(id))); }, [value, directories]);
  const nodes = resultDirectoryNodes(directories);
  const branch = (parent: string | null, depth = 0, seen = new Set<string>()): React.ReactNode => depth < 32 && nodes.filter(node => node.parentId === parent && !seen.has(node.id)).map(node => {
    const children = nodes.some(child => child.parentId === node.id), expanded = !collapsed.includes(node.id);
    return <li key={node.id}><div className={'result-directory-row' + (value === node.id ? ' is-selected' : '')} style={{ paddingLeft: 8 + depth * 14 }}>
      {children ? <button type="button" className="result-directory-chevron" aria-label={`${expanded ? '收起' : '展开'}目录：${node.name}`} aria-expanded={expanded} onClick={() => setCollapsed(current => expanded ? [...current, node.id] : current.filter(id => id !== node.id))}>{expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button> : <span className="result-directory-chevron"/>}
      <button type="button" className="result-directory-name" title={resultDirectoryLabel(node.id, directories)} aria-current={value === node.id ? 'page' : undefined} disabled={disabled} onClick={() => change(node.id)}><Folder size={14}/><span>{node.name}</span>{counts[node.id] !== undefined && <small>{counts[node.id]}</small>}</button>
    </div>{children && expanded && <ul>{branch(node.id, depth + 1, new Set([...seen, node.id]))}</ul>}</li>;
  });
  return <nav className="result-directory-tree" aria-label="成果目录">{all && <button type="button" className={'result-directory-all' + (value === 'all' ? ' is-selected' : '')} disabled={disabled} onClick={() => change('all')}>全部目录</button>}<ul>{branch(null)}</ul></nav>;
}

function DirectoryManagement({ state, value, select, manage = true, disabled = false }: { state: DirectoryState; value: string; select: (id: string) => void; manage?: boolean; disabled?: boolean }) {
  const [action, setAction] = useState<'create' | 'rename' | 'delete'>(), [name, setName] = useState(''), [parentId, setParentId] = useState('exploration'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [target, setTarget] = useState<ResultDirectory>();
  const directory = state.directories.find(item => item.id === value && !item.deletedAt);
  const close = () => { if (!busy) setAction(undefined); };
  useEffect(() => { if (!action) return; const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopImmediatePropagation(); if (!busy) setAction(undefined); } }; document.addEventListener('keydown', escape, true); return () => document.removeEventListener('keydown', escape, true); }, [action, busy]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const id = action === 'create' ? crypto.randomUUID() : target!.id;
      const command: ResultDirectoryCommand = action === 'create' ? { action, id, parentId, name } : action === 'rename' ? { action, id, revision: target!.revision, name } : { action: 'delete', id, revision: target!.revision };
      const next = await state.change(command); select(action === 'delete' ? resolveResultFolder(id, next) : id); setAction(undefined);
    } catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
  };
  const options = resultDirectoryNodes(state.directories);
  return <><div className="result-directory-management">
    <button type="button" className="secondary compact" disabled={disabled || !state.loaded} onClick={() => { setParentId(value === 'all' ? 'exploration' : resolveResultFolder(value, state.directories)); setName(''); setError(''); setAction('create'); }}><FolderPlus size={14}/>新建目录</button>
    {manage && directory && <><button type="button" className="text-button" disabled={disabled} onClick={() => { setTarget({ ...directory }); setName(directory.name); setError(''); setAction('rename'); }}>重命名</button><button type="button" className="text-button danger" disabled={disabled} onClick={() => { setTarget({ ...directory }); setError(''); setAction('delete'); }}>删除目录</button></>}
  </div>{action && <div className="modal-backdrop result-directory-modal" onMouseDown={event => { if (event.target === event.currentTarget) { event.stopPropagation(); close(); } }}><section className="modal" role="dialog" aria-modal="true" aria-label={action === 'create' ? '新建目录' : action === 'rename' ? '重命名目录' : '删除目录'}>
    <header><h2>{action === 'create' ? '新建目录' : action === 'rename' ? '重命名目录' : '删除目录'}</h2><button type="button" className="icon" disabled={busy} aria-label="关闭目录窗口" onClick={close}>×</button></header>
    <div className="modal-body">{action === 'delete' ? <p>删除“{target?.name}”后，其中的成果和子目录会移到上一级，内容会保留。</p> : <>{action === 'create' && <label className="field">上级目录<select aria-label="上级目录" value={parentId} onChange={event => setParentId(event.target.value)}>{options.map(item => <option key={item.id} value={item.id}>{resultDirectoryLabel(item.id, state.directories)}</option>)}</select></label>}<label className="field">目录名称<input autoFocus aria-label="目录名称" value={name} maxLength={60} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && name.trim() && !busy) void save(); }}/></label></>}{error && <div className="inline-error" role="alert">{error}</div>}</div>
    <footer><button type="button" className="secondary" disabled={busy} onClick={close}>取消</button><button type="button" className={action === 'delete' ? 'primary danger' : 'primary'} disabled={busy || action !== 'delete' && !name.trim()} onClick={() => void save()}>{busy ? '正在保存…' : action === 'delete' ? '删除目录，保留内容' : '保存目录'}</button></footer>
  </section></div>}</>;
}

export function ResultDirectorySidebar({ state, value, change, items, manage = true, disabled = false }: { state: DirectoryState; value: string; change: (id: string) => void; items: { folderId?: string; title: string; category?: string; kind?: string }[]; manage?: boolean; disabled?: boolean }) {
  const counts: Record<string, number> = {};
  for (const item of items) for (const node of resultDirectoryPath(resultItemFolder(item, state.directories), state.directories)) counts[node.id] = (counts[node.id] || 0) + 1;
  useEffect(() => { if (state.loaded && value !== 'all') { const resolved = resolveResultFolder(value, state.directories); if (resolved !== value) change(resolved); } }, [value, state.directories, state.loaded]);
  return <aside className="result-directory-sidebar"><div className="result-directory-heading"><b>目录</b><span className="muted small">成果数含子目录</span></div><DirectoryTree directories={state.directories} value={value} change={change} all counts={counts} disabled={disabled}/><DirectoryManagement state={state} value={value} select={change} manage={manage} disabled={disabled}/>{state.error && <p className="small directory-error" role="status">目录暂未更新：{state.error}<button type="button" className="text-button" onClick={() => void state.load()}>刷新目录</button></p>}</aside>;
}

interface DestinationItem { id: string; title: string; category?: string; folderId?: string; kind?: string }
interface DestinationRequest { scope: Scope; title?: string; items: DestinationItem[]; details?: React.ReactNode; confirmLabel?: string }
function DestinationDialog({ projectId, request, finish }: { projectId: string; request: DestinationRequest; finish: (value?: Record<string, string>) => void }) {
  const state = useResultDirectories(projectId, request.scope);
  const [folders, setFolders] = useState<Record<string, string>>({}), [selected, setSelected] = useState(request.items[0].id);
  const selectedItem = request.items.find(item => item.id === selected)!;
  const folder = (item: DestinationItem) => folders[item.id] || resultItemFolder(item, state.directories);
  // Resolve original locations only once the directory snapshot has arrived.
  const current = folder(selectedItem);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('.result-directory-modal')) { event.stopImmediatePropagation(); finish(); } }; document.addEventListener('keydown', escape, true); return () => document.removeEventListener('keydown', escape, true); }, []);
  return <div className="modal-backdrop result-destination-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) finish(); }}><section className="modal result-destination-modal" role="dialog" aria-modal="true" aria-label="选择成果保存目录">
    <header><h2>{request.title || `选择${request.scope === 'personal' ? '个人' : '团队'}目录`}</h2><button type="button" className="icon" aria-label="取消选择目录" onClick={() => finish()}>×</button></header>
    <div className="modal-body"><p className="muted small">{request.scope === 'personal' ? '保存到个人成果库' : '提交到团队成果库'}{request.items.length > 1 ? '，每条成果可选择不同目录。' : '，原成果的位置保持不变。'}</p>
      {state.error && <div className="inline-error" role="alert">{state.error}<button type="button" className="text-button" onClick={() => void state.load()}>刷新目录</button></div>}
      <div className="result-destination-grid"><div className="result-destination-items" aria-label="选择需要指定目录的成果">{request.items.map(item => <button type="button" key={item.id} className={selected === item.id ? 'is-selected' : ''} onClick={() => setSelected(item.id)}><b>{item.title}</b><small>{state.loaded ? resultDirectoryLabel(folder(item), state.directories) : '正在读取目录…'}</small></button>)}</div>
        <div><DirectoryTree directories={state.directories} value={current} change={id => setFolders(previous => ({ ...previous, [selected]: id }))} disabled={!state.loaded}/><DirectoryManagement state={state} value={current} select={id => setFolders(previous => ({ ...previous, [selected]: id }))} manage={false}/></div>
      </div>{request.items.length > 1 && <button type="button" className="text-button" disabled={!state.loaded} onClick={() => setFolders(Object.fromEntries(request.items.map(item => [item.id, current])))}>全部保存到当前选中的目录</button>}{request.details}
    </div><footer><button type="button" className="secondary" onClick={() => finish()}>取消</button><button type="button" className="primary" disabled={!state.loaded} onClick={() => finish(Object.fromEntries(request.items.map(item => [item.id, folder(item)])))}>{request.confirmLabel || '确认目录并继续'}</button></footer>
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
