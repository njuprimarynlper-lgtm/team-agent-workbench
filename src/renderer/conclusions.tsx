import { ErrorLogLink } from './error-notice';
import { uiErrorMessage } from '../shared/user-failure';
import { collaborationFailure } from './collaboration-failure';
import { supportsSessionResults } from '../shared/session-results';
import { ResultDirectorySidebar, useResultDirectories, useResultDestination, moveResultDestinations } from './result-directories';
import { resultDirectoryLabel, resultItemFolder, resultDirectoryPath } from '../shared/result-directories';
import { conclusionPublicationOrigin } from '../core/conclusion-sharing';
import type { ConclusionDeletePreview } from '../shared/conclusion-upload';
import { MarkdownEditor } from './markdown-editor';
import { PERSONAL_PROJECT_ID } from '../shared/personal-workspace';
import { canonicalCategory, orderedResults, resultCategory, resultDefaultStatus, resultStateLabel, type ResultStatus } from '../shared/result-model';
import { ResultHistoryDrawer, ResultStatusSelect } from './result-lifecycle';
import { resultPreview } from '../shared/result-reading';
import { conclusionUploadState, uploadFilesKey } from '../shared/conclusion-upload';
import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from './math-markdown';
import remarkGfm from 'remark-gfm';
import { Archive, Check, Sparkles, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import type { AgentSession, Draft, FilePreview, Project, ProjectConclusion } from '../shared/types';
import { attachedConclusion } from '../shared/conclusion-context';
import { matchesResultLabel, resultLabels, resultLabelTitle } from '../shared/result-labels';
import { ResultCard, ResultMoreMenu } from './result-card';
import { ConclusionAttachments } from './attachments';
import { newerTeamSources, resultLineage } from '../shared/result-lineage';
import { materialCategories, contributionCategoryInfo, contributionTitle, titleSubject, type ContributionCategory, type ResultReference, type SharedContent } from '../shared/content';

const api = window.workbench;
const conclusionTitle = (value: ProjectConclusion) => titleSubject(resultLabelTitle(value.title, value.titleAlias)) || value.title;
type HistoryView = 'all' | 'history' | 'current';
const matchesHistoryView = (value: ProjectConclusion, view: HistoryView) => view === 'all' || (view === 'history' ? !!value.archived : !value.archived);

export function ConclusionLibrary({ project, username = '', projects = [], sessions, notice, mergeStarted, focusId, focusHandled, refreshToken, categories = [...materialCategories], embedded = false }: { username?: string; embedded?: boolean; categories?: ContributionCategory[]; refreshToken?: string; project: Project; projects?: Project[]; sessions: AgentSession[]; notice: (text: string) => void; mergeStarted: (draft: Draft) => void; focusId?: string; focusHandled?: () => void }) {
  const directories = useResultDirectories(project.id, 'personal'), destination = useResultDestination(project.id);
  const [folder, setFolder] = useState('all');
  const changeFolder = (id: string) => { setFolder(id); setQuery(''); setTodoFilter('all'); setSelected(''); setMergeSelection([]); setDeleteSelection([]); };
  useEffect(() => setFolder('all'), [project.id]);
  const [items, setItems] = useState<ProjectConclusion[]>([]), [selected, setSelected] = useState(''), [historyView, setHistoryView] = useState<HistoryView>('current');
  const [teamRevisions, setTeamRevisions] = useState<Record<string, number>>({});
  const [teamItems, setTeamItems] = useState<SharedContent[]>([]);
  const teamRevisionRequest = useRef(0);
  const [editing, setEditing] = useState(false), [creating, setCreating] = useState(false), [title, setTitle] = useState(''), [content, setContent] = useState('');
  const [stagedFiles, setStagedFiles] = useState<{ id: string; name: string; size: number }[]>([]);
  const stagedRef = useRef(stagedFiles); stagedRef.current = stagedFiles;
  const [readError, setReadError] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [mergeSelection, setMergeSelection] = useState<string[]>([]);
  const [confirmingMerge, setConfirmingMerge] = useState(false), [instruction, setInstruction] = useState(''), [mergeSessionId, setMergeSessionId] = useState('');
  const [attaching, setAttaching] = useState<ProjectConclusion>(), [attachSelection, setAttachSelection] = useState<string[]>([]), [attachedIds, setAttachedIds] = useState<string[]>([]);
  const [category, setCategory] = useState<ContributionCategory>('exploration');
  const [query, setQuery] = useState('');
  const [editStatus, setEditStatus] = useState<ResultStatus>(), [editOwner, setEditOwner] = useState('');
  const [historyItem, setHistoryItem] = useState<ProjectConclusion>();
  const [todoFilter, setTodoFilter] = useState('all');
  const [pendingDelete, setPendingDelete] = useState<ProjectConclusion[]>([]), [deleteError, setDeleteError] = useState('');
  const publishing = useRef(false), activeProject = useRef(project.id); activeProject.current = project.id;
  const [selectingDelete, setSelectingDelete] = useState(false), [deleteSelection, setDeleteSelection] = useState<string[]>([]);
  const [deletePreview, setDeletePreview] = useState<{ key: string; items: ConclusionDeletePreview[] }>();
  const deleteKey = pendingDelete.map(item => item.id + ':' + item.version).join(',');
  const deleteLinked = deletePreview?.key === deleteKey ? deletePreview.items : undefined;
  useEffect(() => {
    if (!pendingDelete.length) return;
    let active = true; setDeleteError('');
    void api.call<ConclusionDeletePreview[]>('conclusion.deletePreview', { selections: pendingDelete.map(({ id, version }) => ({ id, version })) }).then(items => { if (active) setDeletePreview({ key: deleteKey, items }); }).catch((error: any) => { if (active) { setDeletePreview({ key: deleteKey, items: [{ localId: '', projectId: project.id, title: '', status: 'error', message: '无法确认团队关联：' + uiErrorMessage(error, { domain: 'central', operation: '检查团队成果关联' }) }] }); } });
    return () => { active = false; };
  }, [deleteKey]);
  const remove = async (syncTeam = false) => {
    if (!pendingDelete.length) return; setBusy(true); setDeleteError('');
    try {
      const result = await api.call<{ missing?: string[] }>('conclusion.deleteMany', { selections: pendingDelete.map(value => ({ id: value.id, version: value.version })), syncTeam, publications: deleteLinked || [] });
      const removed = new Set(pendingDelete.map(value => value.id));
      setItems(current => current.filter(value => !removed.has(value.id)));
      setMergeSelection(current => current.filter(id => !removed.has(id)));
      if (removed.has(selected)) setSelected('');
      setPendingDelete([]); setDeleteSelection([]); setSelectingDelete(false); notice(`已删除 ${removed.size} 条本地成果${syncTeam ? '，关联的团队成果已同步处理' : '，未请求删除团队成果'}。${result?.missing?.length ? result.missing.join('、') + '：团队原成果已不存在。' : ''}已有会话中的引用仍然保留`);
    } catch (e: any) { setDeleteError(uiErrorMessage(e, { domain: 'local', operation: '操作个人成果' })); } finally { setBusy(false); }
  };
  const saveAlias = async (item: ProjectConclusion, alias: string) => {
    const saved = await api.call<ProjectConclusion>('conclusion.alias.save', { id: item.id, alias });
    setItems(current => current.map(value => value.id === saved.id ? { ...saved, uploadState: value.uploadState } : value));
    notice(alias.trim() ? '本地别名已保存' : '已恢复原名');
  };
  const attachSessions = sessions.filter(session => supportsSessionResults(session) && session.binding?.project.id === project.id);
  useEffect(() => {
    const available = new Set(attachSessions.map(session => session.id));
    setAttachSelection(current => { const selected = current.filter(id => available.has(id)); return selected.length === current.length ? current : selected; });
  }, [sessions, project.id]);
  const alreadyAttached = (session: AgentSession) => !!attaching && (!!attachedConclusion(session, attaching.id, attaching.version) || attachedIds.includes(session.id));
  const newSelection = attachSelection.filter(id => attachSessions.some(session => session.id === id && !session.closedAt && !alreadyAttached(session)));
  const attach = async () => {
    if (!attaching) return; setBusy(true); setError('');
    try {
      for (const id of newSelection) {
        await api.call('session.attachConclusion', { id, conclusionId: attaching.id, expectedVersion: attaching.version });
        setAttachedIds(current => [...new Set([...current, id])]);
        setAttachSelection(current => current.filter(value => value !== id));
      }
      notice(`已加入 ${newSelection.length} 个会话，下次提问时自动带入上下文`); setAttaching(undefined);
    } catch (e: any) { setError(uiErrorMessage(e, { domain: 'local', operation: '操作个人成果' })); } finally { setBusy(false); }
  };
  const load = async () => { setBusy(true); try { setItems(await api.call<ProjectConclusion[]>('conclusion.list', { projectId: project.id, includeArchived: true })); setReadError(''); const request = ++teamRevisionRequest.current; void api.call<SharedContent[]>('content.list', { projectId: project.id }).then(shared => { if (request === teamRevisionRequest.current) { setTeamItems(shared); setTeamRevisions(Object.fromEntries(shared.map(value => [value.id, value.revision]))); } }).catch(() => {}); } catch (e: any) { setReadError(collaborationFailure(e, '个人成果没加载出来。请点“刷新个人成果”再试。', { domain: 'local', operation: '读取个人成果列表' })); } finally { setBusy(false); } };
  useEffect(() => { const pending = stagedRef.current; stagedRef.current = []; setStagedFiles([]); for (const file of pending) void api.call('conclusion.files.remove', { fileId: file.id }); setHistoryItem(undefined); setReadError(''); setItems([]); setSelected(''); setCreating(false); setEditing(false); setTodoFilter('all'); setQuery(''); setHistoryView('current'); setTeamItems([]); setPendingDelete([]); setSelectingDelete(false); setDeleteSelection([]); setMergeSelection([]); setConfirmingMerge(false); setInstruction(''); void load(); }, [project.id]);
  useEffect(() => { if (!sessions.some(session => session.id === mergeSessionId)) setMergeSessionId(sessions[0]?.id || ''); }, [sessions, mergeSessionId]);
  useEffect(() => { if (refreshToken && !editing) void load(); }, [refreshToken]);
  useEffect(() => { const target = items.find(item => item.id === focusId); if (!target) return; setHistoryView(target.archived ? 'history' : 'current'); setFolder('all'); setTodoFilter('all'); setQuery(''); open(target); focusHandled?.(); }, [focusId, items]);
  const item = items.find(value => value.id === selected), scopedItems = items.filter(value => matchesHistoryView(value, historyView));
  const hasFolderResults = items.some(value => query.trim() || folder === 'all' || resultItemFolder(value, directories.directories) === folder);
  const filteringTodos = !query.trim() && folder !== 'all' && resultDirectoryPath(folder, directories.directories)[0]?.id === 'todo';
  const visible = orderedResults(scopedItems.filter(value => (query.trim() || folder === 'all' || resultItemFolder(value, directories.directories) === folder) && `${conclusionTitle(value)} ${value.title} ${value.content} ${resultDirectoryLabel(resultItemFolder(value, directories.directories), directories.directories)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (!filteringTodos || todoFilter === 'all' || (todoFilter === 'completed' ? value.resultStatus === 'completed' : !['completed', 'cancelled'].includes(value.resultStatus || 'pending')))));
  const hasNewerTeamSource = (value: ProjectConclusion) => newerTeamSources(value.derivedFrom || [], ref => { const local = items.find(entry => ref.scope === 'personal' && entry.id === ref.id); return local?.version === ref.version ? local : local?.versions?.find(version => version.version === ref.version); }, teamRevisions).length > 0;
  const hasFilters = query || filteringTodos && todoFilter !== 'all';
  const changeHistoryView = (next: HistoryView) => { setHistoryView(next); if (item && !matchesHistoryView(item, next)) setSelected(''); setDeleteSelection([]); setMergeSelection([]); };
  const selectedDeleteItems = visible.filter(value => deleteSelection.includes(value.id));
  const selectedMergeItems = visible.filter(value => !value.archived && mergeSelection.includes(value.id));
  const mergeCategory = resultCategory(selectedMergeItems[0] || { title: '' });
  const mergeReady = selectedMergeItems.length > 0 && selectedMergeItems.length <= 20 && selectedMergeItems.every(value => resultCategory(value) === mergeCategory);
  const sourceSummary = (value: ProjectConclusion) => !value.sources.length ? '手工记录' : [...new Set(value.sources.map(source => ({ session: '本地整理', remote: '共享区', conclusion: '项目成果', manual: '手工记录' })[source.kind]))].join('、');
  const open = (value: ProjectConclusion) => { setSelected(value.id); setCreating(false); setEditing(false); setTitle(titleSubject(value.title)); setCategory(resultCategory(value) || 'exploration'); setEditStatus(value.resultStatus || resultDefaultStatus(resultCategory(value))); setEditOwner(value.resultOwner || ''); setContent(value.content); };
  const discardStaged = async () => { const pending = stagedRef.current; stagedRef.current = []; setStagedFiles([]); for (const file of pending) await api.call('conclusion.files.remove', { fileId: file.id }); };
  const beginCreate = (folderId: string) => { void discardStaged(); setFolder(folderId); const directoryCategory = canonicalCategory(resultDirectoryPath(folderId, directories.directories)[0]?.id); const next = directoryCategory && categories.includes(directoryCategory) ? directoryCategory : categories[0]; setHistoryView('current'); setSelected(''); setCreating(true); setEditing(true); setTitle(''); setCategory(next); setEditStatus(resultDefaultStatus(next)); setEditOwner(''); setContent(''); setTodoFilter('all'); setQuery(''); };
  const remember = (saved: ProjectConclusion) => setItems(current => current.map(value => value.id === saved.id ? saved : value));
  const addFiles = async () => { if (creating) { const added = await api.call<{ id: string; name: string; size: number }[]>('conclusion.files.stage'); setStagedFiles(current => [...current, ...added]); return; } if (!item) return; remember(await api.call<ProjectConclusion>('conclusion.files.add', { id: item.id })); };
  const removeFile = async (fileId: string) => { if (creating) { await api.call('conclusion.files.remove', { fileId }); setStagedFiles(current => current.filter(file => file.id !== fileId)); return; } if (!item) return; remember(await api.call<ProjectConclusion>('conclusion.files.remove', { id: item.id, fileId })); };
  const previewFile = (id: string | undefined, fileId: string) => api.call<FilePreview>('conclusion.file.preview', { id, fileId });
  const save = async () => {
    if (!title.trim() || !content.trim()) return; setBusy(true); setError('');
    try { const saved = creating ? await api.call<ProjectConclusion>('conclusion.create', { projectId: project.id, title: contributionTitle(category, title), content, category, resultStatus: editStatus, resultOwner: editOwner, fileIds: stagedFiles.map(file => file.id), folderId: folder === 'all' ? canonicalCategory(category) : folder }) : await api.call<ProjectConclusion>('conclusion.save', { id: item!.id, title: contributionTitle(category, title), content, category, resultStatus: editStatus, resultOwner: editOwner, version: item!.version }); if (creating) { stagedRef.current = []; setStagedFiles([]); } setCreating(false); setEditing(false); setTodoFilter('all'); setQuery(''); await load(); setSelected(saved.id); notice(creating ? '项目成果已创建' : '项目成果已保存为新版本'); }
    catch (e: any) { setError(uiErrorMessage(e, { domain: 'local', operation: '操作个人成果' })); } finally { setBusy(false); }
  };
  const archive = async (value: ProjectConclusion, archived: boolean) => { setBusy(true); try { await api.call('conclusion.archive', { id: value.id, archived }); await load(); if (archived) { setSelected(current => current === value.id ? '' : current); setMergeSelection(current => current.filter(id => id !== value.id)); } notice(archived ? '成果已移入历史，不再推荐给新会话' : '成果已恢复使用'); } catch (e: any) { setError(uiErrorMessage(e, { domain: 'local', operation: '操作个人成果' })); } finally { setBusy(false); } };
  const toggleMerge = (id: string, checked: boolean) => setMergeSelection(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id));
  const startMerge = async () => {
    setBusy(true); setError('');
    try { const draft = await api.call<Draft>('conclusion.merge.prepare', { projectId: project.id, sessionId: mergeSessionId, sourceIds: selectedMergeItems.map(value => value.id), instruction }); setConfirmingMerge(false); mergeStarted(draft); }
    catch (e: any) { setError(uiErrorMessage(e, { domain: 'local', operation: '操作个人成果' })); }
    finally { setBusy(false); }
  };
  const publication = (value: ProjectConclusion, shared = teamItems) => {
    const origin = conclusionPublicationOrigin(value);
    return shared.find(item => (origin?.contentId ? item.id === origin.contentId : item.path === origin?.path) && (item.author === username || !!value.publication));
  };
  const publish = async (value: ProjectConclusion) => {
    if (publishing.current) return;
    publishing.current = true; setBusy(true); setError('');
    try {
      const shared = await api.call<SharedContent[]>('content.list', { projectId: project.id });
      if (activeProject.current !== project.id) return;
      setTeamItems(shared);
      const original = publication(value, shared), sharedBefore = !!value.publication;
      if (sharedBefore && !original) throw new Error('团队中的原成果已不存在；本次未新增成果，请先核对团队成果');
      let disclose: ResultReference[] = [], updateContent = false;
      const dirty = conclusionUploadState(value).status !== 'done' || original && (original.description !== value.content || titleSubject(original.title) !== titleSubject(value.title) || uploadFilesKey(original.attachments) !== uploadFilesKey(value.localFiles));
      const folders = await destination.choose({ scope: 'team', title: original ? '更改团队路径' : '分享至团队', confirmLabel: original ? '保存路径' : '分享至团队',
        items: [{ id: value.id, title: conclusionTitle(value), category: original ? resultCategory(original) : resultCategory(value), folderId: original?.folderId }],
        ...(original && dirty ? { updateContent: { label: '同时更新团队内容', confirmLabel: '更新内容并保存路径', change: (checked: boolean) => { updateContent = checked; } } } : {}),
        details: original ? <p className="muted small">团队 v{original.revision} · 默认只更改路径{dirty ? '；勾选后以当前个人成果替换团队正文和附件。' : '，正文和附件保持原样。'}</p> : !!value.derivedFrom?.length && <SourceDisclosure references={value.derivedFrom} change={refs => { disclose = refs; }}/> });
      if (!folders || activeProject.current !== project.id) return;
      const folderId = folders[value.id];
      if (original && !updateContent) {
        await moveResultDestinations(project.id, 'team', [{ id: original.id, title: original.title, version: original.revision, folderVersion: original.folderVersion }], { [original.id]: folderId });
      } else await api.call('conclusion.publish', { id: value.id, version: value.version, disclose, folderId, ...(original ? { expectedTeamRevision: original.revision } : {}) });
      if (activeProject.current === project.id) await load();
      notice(original && !updateContent ? '团队路径已保存，正文和附件保留' : original ? '已开始更新原团队成果' : '已开始分享至团队');
    } catch (reason: any) { setError(uiErrorMessage(reason, { domain: 'local', operation: '操作个人成果' })); }
    finally { publishing.current = false; setBusy(false); }
  };
  const move = async (values: ProjectConclusion[]) => { setBusy(true); setError(''); try { const folders = await destination.choose({ scope: 'personal', title: '更改个人目录', items: values }); if (!folders) return; await moveResultDestinations(project.id, 'personal', values.map(value => ({ id: value.id, title: value.title, version: value.version, folderVersion: value.folderVersion })), folders, directories.directories); await directories.load(); await load(); setMergeSelection([]); setDeleteSelection([]); notice('成果目录已更新，内容和分享关联保留'); } catch (reason: any) { await load(); setError(uiErrorMessage(reason, { domain: 'local', operation: '操作个人成果' })); } finally { setBusy(false); } };
  const renderEditor = () => <>
    {creating && <p className="muted small">保存位置：{resultDirectoryLabel(folder === 'all' ? canonicalCategory(category)! : folder, directories.directories)}</p>}
    <p className="muted small">一级目录：{contributionCategoryInfo[category].label} · 可通过“更改个人目录”调整。</p>
    <ResultStatusSelect category={canonicalCategory(category)!} value={editStatus} change={setEditStatus}/>{canonicalCategory(category) === 'todo' && <label className="field">负责人<input value={editOwner} aria-label="待办负责人" onChange={event => setEditOwner(event.target.value)}/></label>}
    <label className="field">标题<input aria-label="项目成果标题" value={title} maxLength={200} onChange={event => setTitle(event.target.value)}/></label>
    <label className="field">内容<MarkdownEditor aria-label="项目成果内容" rows={16} value={content} onChange={event => setContent(event.target.value)}/></label>
    <ConclusionAttachments files={creating ? stagedFiles : item?.localFiles || []} locked={busy} add={() => void addFiles().catch((reason: any) => setError(uiErrorMessage(reason, { domain: 'local', operation: '操作个人成果' })))} remove={fileId => void removeFile(fileId).catch((reason: any) => setError(uiErrorMessage(reason, { domain: 'local', operation: '操作个人成果' })))} preview={fileId => previewFile(creating ? undefined : item?.id, fileId)}/>
  </>;
  const renderEditActions = () => <>
    <button className="secondary compact" disabled={busy} onClick={() => { if (creating) void discardStaged(); setCreating(false); setEditing(false); if (item) open(item); }}>取消</button>
    <button className="primary compact" disabled={busy || !title.trim() || !content.trim()} onClick={() => void save()}><Check size={14}/>保存成果</button>
  </>;
  const updateMetadata = async (value: ProjectConclusion, category?: ContributionCategory, status?: ResultStatus) => {
    setBusy(true); setError('');
    try { await api.call('conclusion.save', { id: value.id, version: value.version, title: value.title, content: value.content, category: category || value.category, resultStatus: status }); await load(); notice(status ? '状态已更新' : '分类已修改，正文和来源保留'); }
    catch (reason: any) { setError(uiErrorMessage(reason, { domain: 'local', operation: '操作个人成果' })); } finally { setBusy(false); }
  };
  const renderActions = (value: ProjectConclusion) => {
    if (editing && selected === value.id) return renderEditActions();
    const disabled = busy || editing || selectingDelete || !!selectedMergeItems.length;
    const uploadState = value.uploadState || conclusionUploadState(value);
    return <>
      {!value.archived && <button className="secondary compact" disabled={disabled} onClick={() => { open(value); setEditing(true); }}>编辑</button>}
      {value.archived && (value.supersededBy ? <span className="muted small">已由新成果替代</span> : <button className="secondary compact" disabled={disabled} onClick={() => void archive(value, false)}><RotateCcw size={14}/>恢复使用</button>)}
      <button className="secondary compact danger" disabled={disabled} onClick={() => { setPendingDelete([value]); setDeleteError(''); }}><Trash2 size={14}/>删除成果</button>
      <ResultMoreMenu disabled={disabled}>
        {!value.archived && <button className="secondary compact" disabled={disabled} onClick={() => void move([value])}>更改个人目录</button>}
        {!value.archived && resultCategory(value) === 'todo' && <button className="secondary compact" disabled={disabled} onClick={() => void updateMetadata(value, value.category || 'todo', ['completed', 'cancelled'].includes(value.resultStatus || '') ? 'pending' : 'completed')}>{['completed', 'cancelled'].includes(value.resultStatus || '') ? '重新打开' : '标记完成'}</button>}
        {!value.archived && resultCategory(value) === 'project_goal' && value.resultStatus !== 'confirmed' && <button className="secondary compact" disabled={disabled} onClick={() => void updateMetadata(value, value.category || 'project_goal', 'confirmed')}>确认目标</button>}
        {!!value.versions?.length && <button className="secondary compact" onClick={() => setHistoryItem(value)}>历史版本 · {value.versions.length}</button>}
        {!value.archived && <button className="secondary compact" disabled={disabled} title="暂时停用，保留内容，可随时恢复" onClick={() => void archive(value, true)}><Archive size={14}/>移入历史</button>}
        {project.id !== PERSONAL_PROJECT_ID && !value.archived && <button className="secondary compact" disabled={disabled || uploadState.status === 'running' || uploadState.status === 'queued'} onClick={() => void publish(value)}>{uploadState.status === 'running' ? '正在分享…' : uploadState.status === 'queued' ? '等待分享' : publication(value) || value.publication ? '更改团队路径' : '分享至团队'}</button>}
        <button className="secondary compact" disabled={disabled || value.archived || !attachSessions.length} title={value.archived ? '请先恢复此成果' : !attachSessions.length ? '请先创建或重新打开当前项目的工作会话' : '选择会话使用这份成果'} onClick={() => { setAttaching(value); setAttachSelection([]); setAttachedIds([]); setError(''); }}>加入会话</button>
      </ResultMoreMenu>
    </>;
  };
  return <div className={(embedded ? 'results-library-pane' : 'workspace-page') + ' conclusion-page'}>
    {!embedded && <div className="page-title"><div><span className="eyebrow">PERSONAL RESULTS</span><h1>个人成果 · {project.name}</h1><p className="muted small">你在本项目中保存的成果，可供会话引用。仅你可见，由你维护，并随账号同步。</p></div></div>}
    {readError && <p className="inline-error" role="alert">{readError} <ErrorLogLink message={readError}/></p>}
    {error && <div className="inline-error" role="alert">{error} <ErrorLogLink message={error}/></div>}
    <div className="result-directory-layout"><ResultDirectorySidebar key={project.id} state={directories} value={query.trim() ? 'all' : folder} change={changeFolder} items={scopedItems} disabled={busy || editing} createResult={beginCreate} resultDisabled={mergeSelection.length > 0 || selectingDelete}/><section className="result-directory-main"><div className="result-directory-breadcrumb"><strong>{query.trim() ? '全部目录的搜索结果' : folder === 'all' ? '全部目录' : resultDirectoryLabel(folder, directories.directories)}</strong></div>
    <div className="result-library-filters"><input aria-label="搜索个人成果" placeholder="搜索全部目录的标题、内容或路径" value={query} disabled={busy || editing} onChange={event => { setQuery(event.target.value); setSelected(''); setMergeSelection([]); setDeleteSelection([]); }}/><button className="icon" aria-label="刷新个人成果" title="刷新个人成果" disabled={busy || editing} onClick={() => void load()}><RefreshCw size={16}/></button>{hasFilters && <button className="team-results-clear" disabled={busy || editing} onClick={() => { setQuery(''); setTodoFilter('all'); setSelected(''); setMergeSelection([]); setDeleteSelection([]); }}>清除筛选</button>}</div>
    {filteringTodos && <div className="row result-category-description"><span>已完成事项保留在下方，仍可查看和重新打开。</span><select aria-label="待办状态筛选" value={todoFilter} onChange={event => setTodoFilter(event.target.value)}><option value="all">全部状态</option><option value="active">未完成</option><option value="completed">已完成</option></select></div>}
    {selectingDelete && <section className="semantic-merge-bar" aria-label="批量删除成果设置"><label className="check-row"><input type="checkbox" aria-label="全选当前成果" disabled={busy || !visible.length} checked={!!visible.length && selectedDeleteItems.length === visible.length} onChange={event => setDeleteSelection(event.target.checked ? visible.map(value => value.id) : [])}/><span>全选当前列表（{visible.length} 条）</span></label><span>已选择 {selectedDeleteItems.length} 条</span><button className="secondary" disabled={busy || !selectedDeleteItems.length || selectedDeleteItems.some(item => item.archived) || selectedDeleteItems.length > 100} onClick={() => void move(selectedDeleteItems)}>更改个人目录</button><button className="secondary danger" disabled={busy || !selectedDeleteItems.length} onClick={() => { setPendingDelete(selectedDeleteItems); setDeleteError(''); }}>删除选中的 {selectedDeleteItems.length} 条成果</button></section>}
    {!!selectedMergeItems.length && <section className="semantic-merge-bar" aria-label="成果处理设置"><div><b>已选择 {selectedMergeItems.length} 条成果</b><small>先生成预处理结果供你审阅和修改，确认保存前原成果保持不变。</small></div><button className="secondary" disabled={busy} onClick={() => setMergeSelection([])}>清空选择</button><button className="secondary" disabled={busy || editing || selectedMergeItems.length > 100} onClick={() => void move(selectedMergeItems)}>更改个人目录</button><button className="primary" disabled={busy || editing || !mergeReady} onClick={() => setConfirmingMerge(true)}>处理选中的 {selectedMergeItems.length} 条成果</button></section>}
    {hasFolderResults && <div className="result-list-toolbar" aria-label="成果列表设置"><span className="muted small">{visible.length} 条{folder !== 'all' && !query.trim() ? ' · 仅本级' : ''}</span><div className="result-list-controls"><label className="result-history-filter">成果范围<select aria-label="成果范围" value={historyView} disabled={busy || editing} onChange={event => changeHistoryView(event.target.value as HistoryView)}><option value="all">全部成果</option><option value="history">历史成果</option><option value="current">当前成果</option></select></label><button className="text-button" disabled={busy || editing} onClick={() => { setSelectingDelete(!selectingDelete); setDeleteSelection([]); setMergeSelection([]); }}>{selectingDelete ? '取消多选' : '批量管理'}</button></div></div>}
    <div className="content-library result-library conclusion-library"><div className="content-cards">
      {creating && <section className="content-card result-card is-expanded" aria-label="新建成果">
        <h2 className="result-card-create-title">新建成果</h2>
        <p className="result-create-location" aria-label="成果保存位置">个人成果库 / {resultDirectoryLabel(folder, directories.directories)}</p>
        <div className="result-card-details">{renderEditor()}</div>
        <div className="content-card-actions result-card-actions">{renderEditActions()}</div>
      </section>}
      {visible.map(value => <ResultCard key={value.id} id={value.id} completed={value.resultStatus === 'completed' || value.resultStatus === 'cancelled'} title={titleSubject(conclusionTitle(value))} alias={{ value: value.titleAlias || '', original: titleSubject(value.title), save: alias => saveAlias(value, alias) }}
        badges={<><span className="content-category-badge">{contributionCategoryInfo[resultCategory(value)!].label}</span>{resultStateLabel(value) && <span className="result-state-badge">{resultStateLabel(value)}</span>}{value.archived && <span className="result-history-badge">历史成果</span>}</>}
        metadata={<>{value.resultOwner ? `负责人：${value.resultOwner} · ` : ''}v{value.version} · {sourceSummary(value)}{value.sources.length > 1 ? ` · ${value.sources.length} 个来源` : ''}{!!value.localFiles?.length && ` · ${value.localFiles.length} 个附件`} · {new Date(value.updatedAt).toLocaleString()}{(folder === 'all' || query.trim()) && <span className="result-directory-path">{resultDirectoryLabel(resultItemFolder(value, directories.directories), directories.directories)}</span>}</>}
        preview={resultPreview(value.content)} expanded={value.id === selected}
        selected={mergeSelection.includes(value.id) || selectingDelete && deleteSelection.includes(value.id)} disabled={editing}
        toggle={() => value.id === selected ? setSelected('') : open(value)}
        selection={selectingDelete ? <label className="content-card-select check-row" title="选择删除"><input type="checkbox" aria-label={`选择删除成果：${conclusionTitle(value)}`} checked={deleteSelection.includes(value.id)} disabled={busy || editing} onChange={event => setDeleteSelection(current => event.target.checked ? [...new Set([...current, value.id])] : current.filter(id => id !== value.id))}/></label> : !value.archived ? <label className="content-card-select check-row" title="选择处理"><input type="checkbox" aria-label={`选择成果：${conclusionTitle(value)}`} checked={mergeSelection.includes(value.id)} disabled={busy || editing} onChange={event => toggleMerge(value.id, event.target.checked)}/></label> : undefined}
        actions={renderActions(value)}>
        {editing && selected === value.id ? renderEditor() : <>
          {value.titleAlias && <p className="muted small">本地别名 · 原名：{titleSubject(value.title) || value.title}</p>}
          <p className="muted small">成果 ID：<code>{value.id}</code> · v{value.version} <button className="text-button" onClick={() => void api.call('copy', value.id).then(() => notice('成果 ID 已复制')).catch(error => setError(uiErrorMessage(error, { domain: 'local', operation: '操作个人成果' })))}>复制 ID</button>{value.supersededBy && <> · 已由 {value.supersededBy.id} 替代</>}</p>
          <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{value.content}</ReactMarkdown></div>
          {!!value.localFiles?.length && <ConclusionAttachments files={value.localFiles} locked={busy} preview={fileId => previewFile(value.id, fileId)}/>}
          {hasNewerTeamSource(value) && <p className="muted small">上游团队成果已有新版本；这条个人成果继续使用保存时的来源版本。</p>}
          {value.derivedFrom?.length ? <details className="content-provenance"><summary>直接来源（{value.derivedFrom.length}）</summary>{value.derivedFrom.map(ref => { const local = items.find(entry => entry.id === ref.id), frozen = local?.version === ref.version ? local : local?.versions?.find(entry => entry.version === ref.version); const team = value.sources.find(source => source.kind === 'remote' && source.id === ref.id && source.revision === ref.version); return <details key={ref.scope + ':' + ref.id + ':' + ref.version}><summary>{ref.scope === 'personal' ? '个人' : '团队'} · {local?.title || team?.title || ref.id} · v{ref.version}{local && local.version > ref.version ? `（已有 v${local.version}）` : ''}</summary><p>ID：<code>{ref.id}</code></p>{frozen ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{frozen.content}</ReactMarkdown></div> : team?.content ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{team.content}</ReactMarkdown></div> : <p>历史正文不可用</p>}</details>; })}</details> : null}
          {value.derivedFrom?.length ? <details className="content-provenance"><summary>完整来源链</summary>{resultLineage(value.derivedFrom, ref => { const local = items.find(entry => ref.scope === 'personal' && entry.id === ref.id); return local?.version === ref.version ? local : local?.versions?.find(version => version.version === ref.version); }).map(ref => <p key={`${ref.scope}:${ref.id}:${ref.version}`}>{ref.scope === 'personal' ? '个人' : '团队'} · <code>{ref.id}</code> · v{ref.version}</p>)}</details> : null}
          {!!value.replaces?.length && <details className="content-provenance"><summary>本成果替代的来源（{value.replaces.length}）</summary>{value.replaces.map(ref => <p key={ref.id + ':' + ref.version}>{ref.scope === 'personal' ? '个人' : '团队'} · {ref.id} · v{ref.version}</p>)}</details>}

          <details className="content-provenance"><summary>资料来源（{value.sources.length || 1}）</summary>{value.sources.length ? value.sources.map((source, index) => <p key={source.kind + ':' + source.id + ':' + index}>{({ session: '本地整理', remote: '共享区', conclusion: '项目成果', manual: '手工记录' })[source.kind]} · {source.title}{source.revision ? ` · v${source.revision}` : ''}{source.details && <span style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{source.details}</span>}</p>) : <p>本机手工记录</p>}</details>
        </>}
      </ResultCard>)}
      {!visible.length && !creating && !readError && <div className="page-empty"><h2>{busy ? '正在读取成果…' : hasFilters ? '暂无匹配成果' : historyView === 'history' ? '暂无历史成果' : historyView === 'current' ? '暂无当前成果' : '还没有项目成果'}</h2><p>{hasFilters ? '可清除筛选查看现有成果。' : hasFolderResults && historyView === 'history' ? '移入历史的成果会显示在这里。' : hasFolderResults && historyView === 'current' && items.some(value => value.archived) ? '可切换到“全部成果”或“历史成果”查看。' : folder === 'all' ? '选中左侧文件夹，点击该行的 ＋ 新建成果。' : '点击左侧所选文件夹右侧的 ＋ 新建成果。'}</p></div>}
    </div></div></section></div>
    {destination.dialog}
    {historyItem && <ResultHistoryDrawer current={historyItem} versions={historyItem.versions || []} close={() => setHistoryItem(undefined)}/>}
    {pendingDelete.length > 0 && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-conclusion-title">
      <header><h2 id="delete-conclusion-title">删除项目成果？</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={() => setPendingDelete([])}>×</button></header>
      <div className="modal-body"><p>将删除以下 {pendingDelete.length} 条项目成果，历史列表中也不再保留，无法通过“恢复使用”找回。</p><ul className="delete-selection-list">{pendingDelete.map(value => <li key={value.id}>{conclusionTitle(value)}{value.archived ? '（历史成果）' : ''}</li>)}</ul><p className="muted small">已经加入会话的引用保留。如果只是暂时不用，请取消并选择“移入历史”。</p>{!deleteLinked ? <p role="status">正在检查团队发布关联…</p> : deleteLinked.length > 0 ? <><p>所选成果有团队发布或来源关联：</p><ul>{deleteLinked.map((link, index) => <li key={link.localId || index}>{link.title}{link.status === 'linked' ? '：团队中也有，可同步删除原条目' : '：' + link.message}</li>)}</ul></> : <p className="muted small">这些成果没有团队发布关联。</p>}{deleteError && <div className="inline-error" role="alert">{deleteError}</div>}</div>
      <footer><button className="secondary" disabled={busy} onClick={() => setPendingDelete([])}>取消</button><button className="secondary danger" disabled={busy} onClick={() => void remove(false)}>{busy ? '正在删除…' : '仅删除本地'}</button>{deleteLinked?.some(item => item.status === 'linked') && <button className="primary danger" disabled={busy || deleteLinked.some(item => item.status === 'error')} onClick={() => void remove(true)}>同时删除团队成果</button>}</footer>
    </section></div>}
    {attaching && <div className="modal-backdrop"><section className="modal attach-session-modal" role="dialog" aria-modal="true" aria-labelledby="attach-conclusion-title"><header><h2 id="attach-conclusion-title">选择使用成果的会话</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={() => setAttaching(undefined)}>×</button></header><div className="modal-body"><p>{conclusionTitle(attaching)}</p><p className="muted small">下次提问时带入所选成果；发送前可在会话输入区撤销，不影响当前正在运行的任务。</p>{error && <div className="inline-error" role="alert">{error} <ErrorLogLink message={error}/></div>}<div className="attach-session-options">{attachSessions.map(session => { const used = alreadyAttached(session); return <label className="attach-session-option" key={session.id}><input type="checkbox" aria-label={`使用成果的会话：${session.title}`} checked={used || attachSelection.includes(session.id)} disabled={busy || used || !!session.closedAt || !!attaching.archived} onChange={e => setAttachSelection(current => e.target.checked ? [...new Set([...current, session.id])] : current.filter(id => id !== session.id))}/><span><b>{session.title}</b><small>{used ? '已加入会话' : session.closedAt ? '会话已关闭' : attaching.archived ? '请先恢复此成果' : '尚未使用'} · {session.provider === 'codex' ? 'Codex' : session.provider === 'claude' ? 'Claude Code' : 'Cursor'}</small></span></label>; })}</div>{!attachSessions.length && <p className="muted">当前项目没有打开的工作会话，请创建或重新打开一个会话。</p>}</div><footer><button className="secondary" disabled={busy} onClick={() => setAttaching(undefined)}>关闭</button><button className="primary" disabled={busy || !newSelection.length} onClick={() => void attach()}>{busy ? '正在加入…' : `加入 ${newSelection.length} 个会话`}</button></footer></section></div>}
    {confirmingMerge && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-conclusion-merge"><header><h2 id="confirm-conclusion-merge">处理所选成果</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={() => setConfirmingMerge(false)}>×</button></header><div className="modal-body"><p>将根据你的要求处理所选 {selectedMergeItems.length} 条成果，生成一份预处理结果。你可以审阅和修改；保存新成果时，可选择将哪些来源移入历史。保留的来源还能用于其他整理组合。</p>{error && <div className="inline-error" role="alert">{error} <ErrorLogLink message={error}/></div>}{sessions.length ? <label className="field">使用哪个会话的模型<select aria-label="用于处理成果的会话" value={mergeSessionId} disabled={busy} onChange={event => setMergeSessionId(event.target.value)}>{sessions.map(session => <option value={session.id} key={session.id}>{session.title} · {session.provider === 'codex' ? 'Codex' : session.provider === 'claude' ? 'Claude Code' : 'Cursor'}</option>)}</select></label> : <p className="inline-error">请先为当前项目创建工作会话。</p>}<label className="field">处理要求（可选）<MarkdownEditor aria-label="成果处理要求" rows={6} disabled={busy} placeholder="例如：保留不同样本范围，去除重复描述；分类保持不变。待办仅合并同一事项的重复记录。" value={instruction} onChange={event => setInstruction(event.target.value)}/></label><div className="merge-confirm-sources">{selectedMergeItems.map(value => <span key={value.id}>{conclusionTitle(value)}</span>)}</div></div><footer><button className="secondary" disabled={busy} onClick={() => setConfirmingMerge(false)}>返回选择</button><button className="primary" disabled={busy || !mergeReady || !mergeSessionId} onClick={() => void startMerge()}><Sparkles size={14}/>{busy ? '正在准备…' : '生成预处理结果'}</button></footer></section></div>}
  </div>;
}

function SourceDisclosure({ references, change }: { references: ResultReference[]; change: (value: ResultReference[]) => void }) {
  const [selected, setSelected] = useState<ResultReference[]>([]);
  return <details><summary>公开直接来源（选填）</summary><p className="muted small">默认不公开个人来源；勾选需要随成果分享的来源。</p>{references.map(ref => <label className="check-row" key={ref.scope + ref.id + ref.version}><input type="checkbox" checked={selected.includes(ref)} onChange={event => { const next = event.target.checked ? [...selected, ref] : selected.filter(value => value !== ref); setSelected(next); change(next); }}/>{ref.scope === 'personal' ? '个人' : '团队'} · {ref.id} · v{ref.version}</label>)}</details>;
}
