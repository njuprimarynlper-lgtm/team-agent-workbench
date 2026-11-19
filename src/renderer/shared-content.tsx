import { collaborationFailure } from './collaboration-failure';
import { uiErrorMessage } from '../shared/user-failure';
import { ErrorLogLink } from './error-notice';
import { supportsSessionResults } from '../shared/session-results';
import { ResultDirectorySidebar, useResultDirectories, useResultDestination, moveResultDestinations } from './result-directories';
import { resultDirectoryLabel, resultItemFolder, resultDirectoryPath } from '../shared/result-directories';
import { MarkdownEditor } from './markdown-editor';
import { cachedTeamRead } from './team-cache';
import { matchesTeamHistory, teamHistoryLabels, teamHistoryReason, type TeamHistoryFilter } from '../shared/team-result-history';
import { contentFileNotice } from '../shared/content-files-state';
import { effectiveResultStatus, canonicalCategory, orderedResults, resultCategory, resultDefaultStatus, resultStateLabel, type ResultStatus } from '../shared/result-model';
import { ResultHistoryDrawer, ResultStatusSelect } from './result-lifecycle';
import { resultPreview } from '../shared/result-reading';
import { matchesResultLabel, resultLabels, resultLabelTitle } from '../shared/result-labels';
import { ResultAliasEditor, ResultCard, ResultMoreMenu } from './result-card';
import { resultLineage } from '../shared/result-lineage';
import { teamResultDifference, teamResultDifferenceLabels } from '../shared/team-result-difference';
import { SubmissionDetails } from './submission-details';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityResultActions } from './activity-result-actions';
import { SharedAttachments } from './attachments';
import { SharedContentDeleteDialog, sharedDeleteSelection } from './shared-content-delete';
import ReactMarkdown from './math-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentSession, ConclusionOrganization, ContentUpdate, Draft, Project, ProjectConclusion } from '../shared/types';
import { contributionCategoryInfo, materialCategories, type ContributionCategory, canDeleteSharedContent, canEditSharedContent, canMoveSharedContent, contentAliasKey, titleSubject, type ContentDeleteResult, type SharedContent } from '../shared/content';
export function SharedContentLibrary({ project, username, admin, aliases, aliasSaved, attach, attachSessions: candidateSessions, notice, mergeSessions, mergeStarted, focusPath, focusHandled, resultId, returnToUpdates, activity, activityChanged, embedded = false }: { embedded?: boolean; project: Project; username: string; admin: boolean; aliases: Record<string, string>; aliasSaved: () => Promise<void>; attach: (item: SharedContent, sessionIds: string[]) => Promise<void>; attachSessions: AgentSession[]; notice: (text: string) => void; mergeSessions: AgentSession[]; mergeStarted: (draft: Draft) => void; focusPath?: string; focusHandled?: () => void; resultId?: string; returnToUpdates?: () => void; activity?: ContentUpdate; activityChanged?: () => Promise<void> }) {
  const directories = useResultDirectories(project.id, 'team'), destination = useResultDestination(project.id);
  const [folder, setFolder] = useState('all');
  const changeFolder = (id: string) => { setFolder(id); setSearch(''); setTodoFilter('all'); setSelected(''); setMergeSelection([]); setDeleteSelection([]); };
  useEffect(() => setFolder('all'), [project.id, username]);
  const [items, setItems] = useState<SharedContent[]>([]), [history, setHistory] = useState<SharedContent[]>([]), [showHistory, setShowHistory] = useState(false), [search, setSearch] = useState(''), [kind, setKind] = useState('all'), [selected, setSelected] = useState('');
  const [editCategory, setEditCategory] = useState<ContributionCategory>('exploration'), [editStatus, setEditStatus] = useState<ResultStatus>(), [editOwner, setEditOwner] = useState('');
  const [historyItem, setHistoryItem] = useState<SharedContent>();
  const [todoFilter, setTodoFilter] = useState('all');
  const [historyFilter, setHistoryFilter] = useState<TeamHistoryFilter>('all');
  const [revealedId, setRevealedId] = useState('');
  const [personal, setPersonal] = useState<ProjectConclusion[]>([]), [showAll, setShowAll] = useState(true), [savingId, setSavingId] = useState('');
  const loadSequence = useRef(0), personalSequence = useRef(0);
  const editingSnapshot = useRef<SharedContent | undefined>(undefined);
  const [editing, setEditing] = useState(false), [title, setTitle] = useState(''), [body, setBody] = useState(''), [repo, setRepo] = useState('');
  const [mutating, setBusy] = useState(false), [error, setError] = useState(''), [pendingDelete, setPendingDelete] = useState<SharedContent>(), [pendingReap, setPendingReap] = useState(false);
  const [uncertainWrite, setUncertainWrite] = useState<{ action: 'save' | 'delete'; value: SharedContent }>();
  const [refreshWarning, setRefreshWarning] = useState('');
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false), [hasCache, setHasCache] = useState(false);
  const busy = mutating || backgroundRefreshing && !hasCache;
  const [selectingMerge, setSelectingMerge] = useState(false), [mergeSelection, setMergeSelection] = useState<string[]>([]), [mergeSessionId, setMergeSessionId] = useState('');
  const [selectingDelete, setSelectingDelete] = useState(false), [deleteSelection, setDeleteSelection] = useState<string[]>([]), [pendingDeleteMany, setPendingDeleteMany] = useState<SharedContent[]>([]);
  const bulkDeleteRunning = useRef(false);
  const contentScope = useRef(''); contentScope.current = JSON.stringify([project.id, username, admin, resultId]);
  const [attachItem, setAttachItem] = useState<SharedContent>(), [attachSelection, setAttachSelection] = useState<string[]>([]), [attachBusy, setAttachBusy] = useState(false);
  const attachSessions = candidateSessions.filter(session => supportsSessionResults(session) && session.binding?.project.id === project.id);
  const currentAttachSelection = attachSelection.filter(id => attachSessions.some(session => session.id === id));
  useEffect(() => {
    const available = new Set(attachSessions.map(session => session.id));
    setAttachSelection(current => { const selected = current.filter(id => available.has(id)); return selected.length === current.length ? current : selected; });
  }, [candidateSessions, project.id]);
  const load = async (resetSelection = true) => {
    const scope = contentScope.current, sequence = ++loadSequence.current, localSequence = ++personalSequence.current; setBackgroundRefreshing(true); if (resetSelection) { setDeleteSelection([]); setError(''); }
    const current = () => scope === contentScope.current && sequence === loadSequence.current;
    try {
      const results = await Promise.allSettled([
        cachedTeamRead<SharedContent[]>(window.workbench, { action: 'content.list', projectId: project.id }, value => { if (current()) { setItems(value || []); setHasCache(value !== undefined); } }),
        cachedTeamRead<SharedContent[]>(window.workbench, { action: 'content.history', projectId: project.id }, value => { if (current()) setHistory(value || []); }),
        window.workbench.call<ProjectConclusion[]>('conclusion.list', { projectId: project.id, includeArchived: true }).then(value => { if (current() && localSequence === personalSequence.current) setPersonal(value); }),
      ]);
      if (!current()) return false;
      const failures = results.flatMap((result, index) => result.status === 'rejected' && !(index === 1 && /不支持的内容操作/.test(result.reason?.message || ''))
        ? [collaborationFailure(result.reason, ['团队成果没加载出来。请点“刷新”再试。', '团队历史没加载出来。请点“刷新”再试。', '个人成果暂时读不到，无法比较个人库与团队库的差异。团队成果仍可查看，点“刷新”再试。'][index], { domain: index === 2 ? 'local' : 'central', operation: index === 2 ? '读取个人成果对照' : '刷新团队成果' })] : []);
      setRefreshWarning(failures.join('；')); return !failures.length;
    } finally { if (current()) setBackgroundRefreshing(false); }
  };
  useEffect(() => { editingSnapshot.current = undefined; setHistoryItem(undefined); setHasCache(false); setRefreshWarning(''); setItems([]); setHistory([]); setUncertainWrite(undefined); setShowHistory(false); setPersonal([]); setShowAll(true); setSavingId(''); setSelected(''); setEditing(false); setTodoFilter('all'); setSearch(''); setKind('all'); setSelectingMerge(false); setMergeSelection([]); setAttachItem(undefined); setAttachSelection([]); setPendingDelete(undefined); void load(); return () => { loadSequence.current++; personalSequence.current++; }; }, [project.id, username, admin, resultId]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.workbench.subscribe(event => {
      if (event.type !== 'state') return;
      clearTimeout(timer); timer = setTimeout(() => {
        const scope = contentScope.current, sequence = ++personalSequence.current;
        void window.workbench.call<ProjectConclusion[]>('conclusion.list', { projectId: project.id, includeArchived: true }).then(values => { if (scope === contentScope.current && sequence === personalSequence.current) setPersonal(values); }, error => { if (scope === contentScope.current && sequence === personalSequence.current) setRefreshWarning(uiErrorMessage(error, { domain: 'local', operation: '读取个人成果对照' })); });
      }, 150);
    });
    return () => { clearTimeout(timer); unsubscribe(); personalSequence.current++; };
  }, [project.id, username, resultId]);
  useEffect(() => { const timer = setInterval(() => { if (!editing && !busy && !backgroundRefreshing && !savingId && document.visibilityState === 'visible') void load(false); }, 30000); return () => clearInterval(timer); }, [project.id, username, resultId, editing, busy, backgroundRefreshing, savingId]);
  const storePersonal = async (value: SharedContent) => {
    if (savingId || busy) return;
    const scope = contentScope.current; setSavingId(value.id); setError('');
    try {
      const existing = personal.find(item => item.sources.some(source => source.kind === 'remote' && source.id === value.id));
      const folders = await destination.choose({ scope: 'personal', title: '存入个人成果库', items: [{ id: value.id, title: displayTitle(value), category: resultCategory(value), folderId: existing?.folderId }] });
      if (!folders || scope !== contentScope.current) return;
      const result = await window.workbench.call<ConclusionOrganization>('conclusion.import', { projectId: project.id, contentId: value.id, expectedRevision: value.revision, folderId: folders[value.id] });
      if (scope !== contentScope.current) return;
      // The server has confirmed this copy. Hide that row immediately, even if
      // the following list refresh fails, and leave another expanded row open.
      personalSequence.current++;
      setPersonal(current => [result.conclusion, ...current.filter(item => item.id !== result.conclusion.id)]);
      setSelected(current => current === value.id ? '' : current); setRevealedId(current => current === value.id ? '' : current); const refreshed = await load();
      if (scope !== contentScope.current) return;
      notice(!refreshed ? '已存入个人成果库，列表刷新失败，请点击刷新重试。' : result.action === 'duplicate' ? '个人成果库中已有这条成果。' : '已存入个人成果库；团队原件保留，个人手工修改不会被覆盖。');
    } catch (reason: any) { if (scope === contentScope.current) setError(uiErrorMessage(reason, { domain: 'central', operation: '操作团队成果' })); }
    finally { if (scope === contentScope.current) setSavingId(''); }
  };

  useEffect(() => { if (!mergeSessions.some(session => session.id === mergeSessionId)) setMergeSessionId(mergeSessions[0]?.id || ''); }, [mergeSessionId, mergeSessions]);
  useEffect(() => { setSelectingDelete(false); setDeleteSelection([]); setPendingDeleteMany([]); }, [project.id, username, admin, resultId]);
  const item = items.find(i => i.id === (resultId || selected)) || history.find(i => i.id === (resultId || selected));
  const open = (value: SharedContent) => { editingSnapshot.current = undefined; setSelected(value.id); setRevealedId(current => current === value.id ? current : ''); setEditing(false); setTitle(value.title); setBody(value.description); setRepo(value.repoUrl || ''); setEditCategory(resultCategory(value) || 'exploration'); setEditStatus(effectiveResultStatus(value)); setEditOwner(value.resultOwner || ''); };
  const edit = (value: SharedContent) => { open(value); editingSnapshot.current = structuredClone(value); setEditing(true); };
  useEffect(() => { if (!focusPath) return; const target = items.find(value => value.path === focusPath); if (target) { setTodoFilter('all'); setSearch(''); setKind('all'); setMergeSelection([]); open(target); setRevealedId(target.id); setFolder('all'); focusHandled?.(); } }, [focusPath, items]);
  // A direct source link may reveal an existing personal copy until it is closed.
  useEffect(() => { if (!selected) setRevealedId(''); }, [selected, project.id, username, admin, resultId]);
  const save = async (action: 'save' | 'delete') => {
    const item = editingSnapshot.current;
    if (!item || uncertainWrite?.value.id === item.id) return; setBusy(true); setError('');
    try { const savedTitle = title.trim(); await window.workbench.call('content.edit', { projectId: project.id, change: { id: item.id, revision: item.revision, action, title: savedTitle, description: body, repoUrl: repo, ...(item.kind === 'contribution' ? { category: editCategory, resultStatus: item.linkedAssignments?.length ? undefined : editStatus, resultOwner: editOwner } : {}), curate: admin, merge: [] } }); setEditing(false); await load(); notice(action === 'delete' ? '团队成果已删除' : '团队成果已更新'); } catch (e: any) { setUncertainWrite({ action: 'save', value: item }); setError(collaborationFailure(e, `还不知道“${title.trim()}”是否已保存，修改内容还在。请点“检查保存结果”，先别再次保存。`, { domain: 'central', operation: '保存团队成果', outcome: 'unknown' })); } finally { setBusy(false); }
  };
  const remove = async (value: SharedContent) => {
    if (uncertainWrite?.value.id === value.id) return;
    setBusy(true); setError('');
    try {
      await window.workbench.call('content.edit', { projectId: project.id, change: { id: value.id, revision: value.revision, action: 'delete', title: value.title, description: value.description, repoUrl: value.repoUrl || '', curate: admin, merge: [] } });
      if (selected === value.id) setSelected(''); setPendingDelete(undefined); await load(); notice(value.supersededBy || value.deletedAt ? '团队历史已删除；未再被引用的会话轨迹、提交文件和附件已清理' : '团队成果已删除；已保存的个人副本保留');
    } catch (e: any) { setUncertainWrite({ action: 'delete', value }); setError(collaborationFailure(e, `还不知道“${displayTitle(value)}”是否已删除。请点“检查删除结果”，先别再次删除。`, { domain: 'central', operation: '删除团队成果', outcome: 'unknown' })); }
    finally { setBusy(false); }
  };
  const checkWriteResult = async () => {
    if (!uncertainWrite || busy) return;
    const pending = uncertainWrite; setBusy(true);
    try {
      const [current, previous] = await Promise.all([
        window.workbench.call<SharedContent[]>('content.list', { projectId: project.id }),
        window.workbench.call<SharedContent[]>('content.history', { projectId: project.id }),
      ]);
      setItems(current); setHistory(previous);
      const latest = [...current, ...previous].find(value => value.id === pending.value.id && !value.deletedAt);
      if (pending.action === 'delete') {
        setUncertainWrite(undefined);
        if (!latest) { setPendingDelete(undefined); setSelected(''); setError(''); notice(`“${displayTitle(pending.value)}”已不在团队成果中，无需再次删除。`); }
        else if (latest.revision === pending.value.revision) setError('这条成果仍在，版本没有变化。现在可以再次确认删除。');
        else { setPendingDelete(undefined); setError('这条成果已有新版本。请先查看最新内容，再决定是否删除。'); }
      } else if (latest && latest.revision > pending.value.revision && latest.title === title.trim() && latest.description === body && (latest.repoUrl || '') === repo) {
        setUncertainWrite(undefined); setEditing(false); setError(''); notice('修改已保存，无需再次保存。');
      } else if (latest?.revision === pending.value.revision) {
        setUncertainWrite(undefined); setError('服务器上仍是修改前的版本，你的修改内容还在。现在可以再次点“保存修改”。');
      } else setError('服务器上的成果已变化，你的修改内容还在。请先复制修改内容，再点“取消编辑”查看最新版本。');
    } catch (reason) { setError(collaborationFailure(reason, `仍没读到这条成果的最新状态。恢复连接后，再点“检查${pending.action === 'save' ? '保存' : '删除'}结果”。`, { domain: 'central', operation: '检查成果修改结果' })); }
    finally { setBusy(false); }
  };
  const checkWriteButton = uncertainWrite && <button className="text-button" disabled={busy} onClick={() => void checkWriteResult()}>检查{uncertainWrite.action === 'save' ? '保存' : '删除'}结果</button>;
  const reap = async () => {
    setBusy(true); setError('');
    try {
      const result = await window.workbench.call<{ removed: number }>('content.reap', { projectId: project.id });
      setPendingReap(false); await load(); notice(`已清理 ${result.removed} 个未引用文件`);
    } catch (e: any) { setError(uiErrorMessage(e, { domain: 'central', operation: '操作团队成果' })); }
    finally { setBusy(false); }
  };
  const startMerge = async () => {
    if (visibleMergeSelection.length < 2 || !mergeSessionId) return; setBusy(true); setError('');
    try { const draft = await window.workbench.call<Draft>('content.merge.prepare', { projectId: project.id, sessionId: mergeSessionId, sourceIds: visibleMergeSelection }); mergeStarted(draft); }
    catch (e: any) { setError(uiErrorMessage(e, { domain: 'central', operation: '操作团队成果' })); }
    finally { setBusy(false); }
  };
  const removeMany = async () => {
    if (bulkDeleteRunning.current || !pendingDeleteMany.length) return;
    const scope = contentScope.current;
    bulkDeleteRunning.current = true; setBusy(true); setError('');
    try {
      const result = await window.workbench.call<ContentDeleteResult>('content.deleteMany', { projectId: project.id, selections: pendingDeleteMany.map(({ id, revision }) => ({ id, revision })) });
      if (scope !== contentScope.current) { notice(`${project.name}：已删除 ${result.deletedIds.length} 项，未完成 ${result.remaining.length} 项`); return; }
      setPendingDeleteMany([]);
      if (result.deletedIds.includes(selected)) setSelected('');
      setItems(current => current.filter(item => !result.deletedIds.includes(item.id)));
      const refreshed = await load();
      if (scope !== contentScope.current) return;
      setDeleteSelection(result.remaining.map(item => item.id)); setSelectingDelete(!!result.remaining.length);
      const summary = `已删除 ${result.deletedIds.length} 项，未完成 ${result.remaining.length} 项`;
      if (result.error || !refreshed) setError(summary + '。' + (result.uncertainId ? '其中 1 项无法确认是否删除，请先刷新核对。' : '') + (result.error ? uiErrorMessage(result.error, { domain: 'central', operation: '删除选中成果', outcome: result.uncertainId ? 'unknown' : 'partial' }) : '列表刷新失败，请重新刷新核对。'));
      notice(summary + '；个人副本和已发送的对话内容保留');
    } catch (e: any) { if (scope === contentScope.current) setError(uiErrorMessage(e, { domain: 'central', operation: '操作团队成果' })); }
    finally { bulkDeleteRunning.current = false; if (scope === contentScope.current) setBusy(false); }
  };
  const mergeBlockedReason = (value: SharedContent) => busy ? '成果列表或操作正在更新，请等待完成。' : value.files && (value.files.body !== 'ok' || Object.values(value.files.attachments).some(status => status !== 'ok')) ? '正文或附件暂不可读，请检查文件后再合并。' : value.linkedAssignments?.length ? `“${displayTitle(value)}”已用于项目任务，不能合并。请点左侧“项目任务”查看关联任务。` : mergeSelection.length && resultCategory(value) !== mergeCategory ? '只能选择与当前所选相同分类的成果。' : '';
  const toggleMerge = (id: string, checked: boolean) => { const value = items.find(item => item.id === id); if (checked && value && mergeSelection.length && resultCategory(value) !== mergeCategory) { setError('只能合并同一分类的成果'); return; } setMergeSelection(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id)); };
  const toggleAttach = (id: string, checked: boolean) => setAttachSelection(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id));
  const completeAttach = async () => {
    if (!attachItem || !currentAttachSelection.length) return;
    setAttachBusy(true); setError('');
    try { await attach(attachItem, currentAttachSelection); setAttachItem(undefined); setAttachSelection([]); }
    catch (e: any) { setError(uiErrorMessage(e, { domain: 'central', operation: '操作团队成果' })); }
    finally { setAttachBusy(false); }
  };
  const categoryLabel = (value: SharedContent) => (resultCategory(value) ? contributionCategoryInfo[resultCategory(value)!].label : '') || (value.kind === 'trajectory' ? '会话轨迹' : value.kind === 'file' ? '共享文件' : '未分类');
  const saveAlias = async (value: SharedContent, alias: string) => {
    await window.workbench.call('content.alias.save', { projectId: project.id, contentId: value.id, alias });
    await aliasSaved(); notice(alias.trim() ? '本地别名已保存，仅自己可见' : '已恢复原名');
  };
  const alias = (value: SharedContent) => aliases[contentAliasKey(project.id, value.id)] || '';
  const displayTitle = (value: SharedContent) => titleSubject(resultLabelTitle(value.title, alias(value)));
  const differences = Object.fromEntries(items.map(value => [value.id, teamResultDifference(value, personal)]));
  const visibleItems = (showHistory ? history.filter(value => matchesTeamHistory(value, historyFilter)) : showAll ? items : items.filter(value => differences[value.id] || value.id === revealedId));
  const matching = visibleItems.filter(i => (search.trim() || folder === 'all' || resultItemFolder(i, directories.directories) === folder) && (kind === 'all' || i.kind === kind) && [displayTitle(i), i.title, categoryLabel(i), i.description, i.author, i.repoUrl || '', i.createdAt, i.updatedAt, new Date(i.updatedAt).toLocaleDateString(), resultDirectoryLabel(resultItemFolder(i, directories.directories), directories.directories)].join(' ').toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const availableKinds = (['contribution', 'file', 'trajectory'] as const).filter(value => visibleItems.some(item => item.kind === value) || kind === value);
  const filteringTodos = !search.trim() && folder !== 'all' && resultDirectoryPath(folder, directories.directories)[0]?.id === 'todo';
  const filtered = orderedResults(matching.filter(i => (!filteringTodos || todoFilter === 'all' || (todoFilter === 'completed' ? effectiveResultStatus(i) === 'completed' : !['completed', 'cancelled'].includes(effectiveResultStatus(i) || 'pending')))));
  const mergeCategory = resultCategory(items.find(value => mergeSelection.includes(value.id)) || { title: '' });
  const visibleMergeSelection = mergeSelection.filter(id => filtered.some(value => value.id === id && value.kind === 'contribution'));
  const hasFilters = search || kind !== 'all' || filteringTodos && todoFilter !== 'all' || showHistory && historyFilter !== 'all';
  const deletion = sharedDeleteSelection(filtered, deleteSelection, username, admin);
  const move = async (values: SharedContent[]) => { setBusy(true); setError(''); try { const folders = await destination.choose({ scope: 'team', title: '更改团队路径', items: values }); if (!folders) return; await moveResultDestinations(project.id, 'team', values.map(value => ({ id: value.id, title: value.title, version: value.revision, folderVersion: value.folderVersion })), folders, directories.directories); await directories.load(); await load(); notice('团队成果目录已更新'); } catch (reason: any) { await load(); setError(uiErrorMessage(reason, { domain: 'central', operation: '操作团队成果' })); } finally { setBusy(false); } };
  const updateMetadata = async (value: SharedContent, category?: ContributionCategory, status?: ResultStatus) => {
    setBusy(true); setError('');
    try { await window.workbench.call('content.edit', { projectId: project.id, change: { id: value.id, revision: value.revision, action: 'save', title: category && !status ? `【${contributionCategoryInfo[category].label}】 ${titleSubject(value.title)}` : value.title, description: value.description, repoUrl: value.repoUrl, category, resultStatus: status, curate: admin } }); await load(); notice(status ? '状态已更新' : '分类已修改，正文和来源保留'); }
    catch (reason: any) { setError(uiErrorMessage(reason, { domain: 'central', operation: '操作团队成果' })); } finally { setBusy(false); }
  };
  const renderBody = (value: SharedContent, isEditing: boolean) => <>
    <p className="muted small">成果 ID：<code>{value.id}</code> · v{value.revision} <button className="text-button" onClick={() => void window.workbench.call('copy', value.id).then(() => notice('成果 ID 已复制')).catch(error => setError(uiErrorMessage(error, { domain: 'central', operation: '操作团队成果' })))}>复制 ID</button>{value.supersededBy && <> · 已由 {value.supersededBy.id} 替代</>}</p>

    {teamHistoryReason(value) === 'merged' && <p className="team-history-note">已合并为“{titleSubject([...items, ...history].find(target => target.id === value.supersededBy?.id)?.title || '另一条团队成果')}”，此条作为合并来源保留。</p>}
    {alias(value) && <p className="muted small">本地别名，仅你可见 · 远端标题：{titleSubject(value.title) || value.title}</p>}
    {isEditing ? <>
      <ResultStatusSelect category={canonicalCategory(editCategory)!} value={editStatus} disabled={!!value.linkedAssignments?.length} change={setEditStatus}/>{resultCategory(value) === 'todo' && <label className="field">负责人<input aria-label="待办负责人" value={editOwner} onChange={event => setEditOwner(event.target.value)}/></label>}<label className="field">标题<input aria-label="团队成果标题" value={title} onChange={e => setTitle(e.target.value)}/></label>
      <label className="field">内容 / 说明<MarkdownEditor aria-label="团队成果内容" rows={14} value={body} onChange={e => setBody(e.target.value)}/></label>
      <label className="field">仓库链接（可选）<input value={repo} onChange={e => setRepo(e.target.value)}/></label>
    </> : <>
      {contentFileNotice(value) && <p className="update-processing-note" role="status">{contentFileNotice(value)}{value.files?.body === 'missing' && ' 以下文字为此前保存的成果记录。'}</p>}
      {value.deletedAt ? <p className="muted">这条成果已删除，仅保留删除记录，正文不可用。</p> : <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:/.test(href)) void window.workbench.call('open.link', href); }}>{children}</a>, img: ({ alt }) => <span>[图片：{alt}]</span> }}>{value.description || '此项为共享文件。'}</ReactMarkdown></div>}
      <SharedAttachments key={value.id} item={value} projectId={project.id}/>
      <SubmissionDetails record={value.submission} legacySource={value.sourceSessionTitle} legacyAuthor={value.author} updatedBy={value.updatedBy} revision={value.revision}>{value.sourceDetails && <pre style={{ whiteSpace: 'pre-wrap' }}>{value.sourceDetails}</pre>}</SubmissionDetails>
      {value.derivedFrom?.length ? <details className="content-provenance"><summary>直接来源（{value.derivedFrom.length}）</summary>{value.derivedFrom.map(ref => { const source = items.find(item => item.id === ref.id && item.revision === ref.version) || history.find(item => item.id === ref.id && item.revision === ref.version); return <details key={ref.id + ':' + ref.version}><summary>{source?.title || ref.id} · v{ref.version}{source && source.revision < Math.max(...[...items, ...history].filter(item => item.id === ref.id).map(item => item.revision)) && ' · 有新版本'}</summary><p>ID：<code>{ref.id}</code></p>{source ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{source.description}</ReactMarkdown></div> : <p>历史正文不可用</p>}</details>; })}</details> : value.provenance?.length ? <details className="content-provenance"><summary>历史来源摘要（正文不可用）</summary>{value.provenance.map(source => <p key={source.id + ':' + source.revision}>{source.title} · {source.author} · v{source.revision}</p>)}</details> : null}
      {value.derivedFrom?.length ? <details className="content-provenance"><summary>完整来源链</summary>{resultLineage(value.derivedFrom, ref => items.find(item => item.id === ref.id && item.revision === ref.version) || history.find(item => item.id === ref.id && item.revision === ref.version)).map(ref => <p key={`${ref.scope}:${ref.id}:${ref.version}`}><code>{ref.id}</code> · v{ref.version}</p>)}</details> : null}
      {!!value.disclosedSources?.length && <details className="content-provenance"><summary>分享人公开的来源（{value.disclosedSources.length}）</summary>{value.disclosedSources.map(ref => <p key={`${ref.scope}:${ref.id}:${ref.version}`}>{ref.scope === 'personal' ? '个人成果' : '团队成果'} · <code>{ref.id}</code> · v{ref.version}</p>)}</details>}
      {!!value.replaces?.length && <details className="content-provenance"><summary>替代记录（{value.replaces.length}）</summary>{value.replaces.map(ref => <p key={ref.id + ':' + ref.version}>{ref.id} · v{ref.version}</p>)}</details>}
      {value.repoUrl && <p>仓库：{value.repoUrl}</p>}
      {value.git && <p className="muted small">分支 {value.git.branch} · Commit {value.git.commit || '无'} · {value.git.dirty ? '存在未提交改动' : '无未提交改动'}</p>}
    </>}
  </>;
  const renderActions = (value: SharedContent, isEditing: boolean) => {
    if (history.includes(value)) {
      const writable = canDeleteSharedContent(value, username, admin);
      if (!writable) return null;
      return <button className="secondary compact danger" aria-label={`删除历史成果：${displayTitle(value)}`} disabled={busy || editing || selectingDelete} onClick={() => { setError(''); setPendingDelete(value); }}>删除历史成果</button>;
    }
    if (isEditing) return <>
      <button className="secondary compact" disabled={busy} onClick={() => open(value)}>取消编辑</button>
      {value.kind !== 'contribution' && <button className="secondary compact" disabled={busy || !title.trim()} onClick={async () => { setBusy(true); try { const saved = await window.workbench.call('content.replace', { projectId: project.id, change: { id: editingSnapshot.current?.id, revision: editingSnapshot.current?.revision, action: 'save', title, description: body, curate: admin } }); if (saved) { setEditing(false); await load(); notice('文件已替换为新修订'); } } catch (e: any) { setError(uiErrorMessage(e, { domain: 'central', operation: '操作团队成果' })); } finally { setBusy(false); } }}>选择文件并保存替换</button>}
      <button className="primary compact" disabled={busy || !title.trim() || uncertainWrite?.value.id === value.id} onClick={() => void save('save')}>保存修改</button>
    </>;
    const fileBlocked = !!value.files && value.files.body !== 'ok';
    const disabled = busy || editing || !!savingId || selectingMerge || selectingDelete;
    const difference = differences[value.id];
    const keepSaveAppearance = backgroundRefreshing && !editing && !savingId && !selectingMerge && !selectingDelete && !!difference;
    const writable = canEditSharedContent(value, username);
    return <>
      {value.linkedAssignments?.length ? <span className="muted small">已关联项目任务 · {value.linkedAssignments.map(task => task.status === 'pending_review' ? '待验收' : task.status === 'completed' ? '已完成' : '按任务进度处理').join('、')}</span> : null}
      {!activity && difference && <button className={'primary compact' + (keepSaveAppearance ? ' result-save-refreshing' : '')} aria-label={resultId ? undefined : `存入个人成果库：${displayTitle(value)}`} title={contentFileNotice(value)} disabled={disabled || fileBlocked} onClick={() => void storePersonal(value)}>{savingId === value.id ? '正在存入…' : '存入个人成果库'}</button>}
      {!activity && !difference && resultId && <span className="muted small">个人库已有此版本</span>}
      {writable && <button className="secondary compact" disabled={disabled} onClick={() => edit(value)}>编辑</button>}
      {canDeleteSharedContent(value, username, admin) && <button className="secondary compact danger" aria-label={resultId ? undefined : `删除团队成果：${displayTitle(value)}`} disabled={disabled} onClick={() => { setError(''); setPendingDelete(value); }}>删除团队成果</button>}
      <ResultMoreMenu disabled={busy || selectingDelete || !!mergeSelection.length}>
        {canMoveSharedContent(value, username, admin) && !value.deletedAt && !value.supersededBy && <button className="secondary compact" disabled={disabled} onClick={() => void move([value])}>更改团队路径</button>}
        {writable && resultCategory(value) === 'todo' && !value.linkedAssignments?.length && <button className="secondary compact" disabled={disabled} onClick={() => void updateMetadata(value, value.category || 'todo', value.resultStatus === 'completed' || value.resultStatus === 'cancelled' ? 'pending' : 'completed')}>{value.resultStatus === 'completed' || value.resultStatus === 'cancelled' ? '重新打开' : '标记完成'}</button>}
        {writable && resultCategory(value) === 'project_goal' && value.resultStatus !== 'confirmed' && <button className="secondary compact" disabled={disabled} onClick={() => void updateMetadata(value, value.category || 'project_goal', 'confirmed')}>确认目标</button>}
        {!!history.filter(entry => entry.id === value.id && entry.revision < value.revision).length && <button className="secondary compact" disabled={disabled} onClick={() => setHistoryItem(value)}>历史版本 · {history.filter(entry => entry.id === value.id && entry.revision < value.revision).length}</button>}
        {value.kind !== 'contribution' && <button className="secondary compact" disabled={disabled || fileBlocked} onClick={() => void window.workbench.call('remote.download', { projectId: project.id, path: value.path }).catch(e => setError(collaborationFailure(e, /中央节点未找到|REMOTE_FILE_MISSING|FILE_MISSING/.test(String(e?.failure?.code || e?.code || '') + ' ' + String(e?.message || '')) ? `服务器上没找到“${displayTitle(value)}”，暂时无法下载。点“刷新”后再试；仍没有时请联系项目管理员。` : `“${displayTitle(value)}”没下载下来。请再点“下载”试一次；仍失败时查看日志。`, { domain: 'central', operation: '下载团队文件' })))}>下载</button>}
        <button className="secondary compact" disabled={disabled || fileBlocked || !attachSessions.length} title={attachSessions.length ? '选择一个或多个会话作为参考资料' : '请先创建或重新打开当前项目的工作会话'} onClick={() => { setAttachItem(value); setAttachSelection([]); }}>加入会话</button>
      </ResultMoreMenu>
    </>;
  };
  return <div className={(embedded ? 'results-library-pane' : 'workspace-page') + ' team-results' + (resultId ? ' activity-result-page' : '')}>
    {(!embedded || resultId) && <div className="page-title"><div>{!embedded && <span className="eyebrow">TEAM CONTENT</span>}{embedded ? <h2>动态结果</h2> : <h1>{resultId ? '动态结果' : '团队成果'} · {project.name}</h1>}</div>{resultId && <div className="row"><button className="secondary" disabled={busy || editing} onClick={returnToUpdates}>返回动态</button><button className="secondary" disabled={busy || editing} onClick={() => void load()}>刷新</button></div>}</div>}
    <div className={resultId ? undefined : 'result-directory-layout'}>{!resultId && <ResultDirectorySidebar key={project.id} state={directories} value={search.trim() ? 'all' : folder} change={changeFolder} items={visibleItems} manage={admin} disabled={busy || editing}/>}<section className="result-directory-main">
    {!resultId && <>
      <div className="result-directory-breadcrumb"><strong>{search.trim() ? '全部目录的搜索结果' : folder === 'all' ? '全部目录' : resultDirectoryLabel(folder, directories.directories)}</strong><span role="status" aria-label="团队成果数量">{busy ? '正在读取…' : `${filtered.length} 条${folder !== 'all' && !search.trim() ? ' · 仅本级' : ''}`}{showHistory ? ' · 历史' : ''}</span></div>
      <div className="team-results-toolbar result-library-toolbar">
        <div className="team-results-summary">{!showHistory && <label className="team-results-include"><input type="checkbox" checked={!showAll} disabled={busy || editing || !!savingId} onChange={event => { setShowAll(!event.target.checked); setTodoFilter('all'); setSearch(''); setKind('all'); setSelected(''); setSelectingMerge(false); setMergeSelection([]); setSelectingDelete(false); setDeleteSelection([]); }}/><span>仅看与个人库的差异</span></label>}</div>
        <div className="team-results-actions">
          <button className="secondary compact" disabled={busy || editing} onClick={() => { setShowHistory(!showHistory); setHistoryFilter('all'); setSelected(''); setSearch(''); setTodoFilter('all'); setKind('all'); setSelectingMerge(false); setMergeSelection([]); setSelectingDelete(false); setDeleteSelection([]); }}>{showHistory ? '返回当前成果' : '查看团队历史'}</button>
          {admin && !showHistory && <button className="secondary compact" disabled={editing || busy} onClick={() => { setSelectingMerge(!selectingMerge); setMergeSelection([]); setSelectingDelete(false); setDeleteSelection([]); }}>{selectingMerge ? '退出多选' : '合并整理'}</button>}
          {!!deletion.eligible.length && <button className="secondary compact" aria-label={selectingDelete ? '取消批量删除' : showHistory ? '批量删除历史成果' : '批量删除团队成果'} disabled={busy || editing || !deletion.eligible.length} onClick={() => { setSelectingDelete(!selectingDelete); setDeleteSelection([]); setSelectingMerge(false); setMergeSelection([]); setError(''); }}>{selectingDelete ? '取消多选' : '批量管理'}</button>}
          {admin && <button className="secondary compact" disabled={busy || editing} onClick={() => setPendingReap(true)}>清理未引用文件</button>}
          <button className="secondary compact" disabled={busy || editing} onClick={() => void load()}>刷新</button>

        </div>
      </div>
      <div className="result-library-filters">{showHistory && <label className="result-history-filter">历史类型<select aria-label="团队历史类型" value={historyFilter} disabled={busy || editing} onChange={event => { setHistoryFilter(event.target.value as TeamHistoryFilter); setSelected(''); setDeleteSelection([]); setMergeSelection([]); }}><option value="all">全部历史</option><option value="merged">合并历史</option><option value="deleted">删除历史</option></select></label>}<input aria-label="搜索团队成果" placeholder="搜索全部目录的标题、内容或路径" value={search} disabled={busy || editing} onChange={e => { setSearch(e.target.value); setSelected(''); setDeleteSelection([]); setMergeSelection([]); }}/>{(availableKinds.length > 1 || kind !== 'all') && <select aria-label="团队成果内容形式" value={kind} disabled={busy || editing} onChange={e => { setKind(e.target.value); setSelected(''); setDeleteSelection([]); setMergeSelection([]); }}><option value="all">全部内容形式</option>{availableKinds.map(value => <option key={value} value={value}>{{ contribution: '文字成果', file: '共享文件', trajectory: '会话轨迹' }[value]}</option>)}</select>}{hasFilters && <button className="team-results-clear" disabled={busy || editing} onClick={() => { setSearch(''); setKind('all'); setTodoFilter('all'); setHistoryFilter('all'); setSelected(''); setDeleteSelection([]); setMergeSelection([]); }}>清除筛选</button>}</div>
    </>}
    {!resultId && filteringTodos && <div className="row result-category-description"><span>已完成事项保留在下方，仍可查看和重新打开。</span><select aria-label="待办状态筛选" value={todoFilter} onChange={event => setTodoFilter(event.target.value)}><option value="all">全部状态</option><option value="active">未完成</option><option value="completed">已完成</option></select></div>}
    {backgroundRefreshing && hasCache && <p className="muted small" role="status">正在更新团队信息，当前内容可继续查看和操作。</p>}
    {refreshWarning && <p className="muted small" role="status">{refreshWarning}</p>}
    {error && !pendingDelete && !pendingDeleteMany.length && <div className="inline-error" role="alert">{error} <ErrorLogLink message={error}/>{checkWriteButton}</div>}
    {admin && !resultId && selectingMerge && <section className="semantic-merge-bar" aria-label="语义合并设置"><div><b>已选择 {visibleMergeSelection.length} 条文字成果</b><small>至少选择 2 条同类成果；待办只合并同一事项的重复记录。</small></div>{mergeSessions.length ? <label>使用模型环境<select aria-label="合并使用的模型环境" value={mergeSessionId} onChange={e => setMergeSessionId(e.target.value)}>{mergeSessions.map(session => <option value={session.id} key={session.id}>{session.title} · {session.provider === 'codex' ? 'Codex' : session.provider === 'claude' ? 'Claude Code' : 'Cursor'}{session.model ? ' · ' + session.model : ''}</option>)}</select></label> : <p className="inline-error">请先为此项目创建一个工作会话，用于提供已登录的 AI 模型环境。</p>}<button className="primary" disabled={busy || visibleMergeSelection.length < 2 || !mergeSessionId} onClick={() => void startMerge()}>{busy ? '正在启动…' : `开始语义合并${visibleMergeSelection.length ? `（${visibleMergeSelection.length} 条）` : ''}`}</button></section>}
    {selectingDelete && !resultId && <section className="semantic-merge-bar" aria-label="团队成果批量删除设置"><label className="check-row"><input type="checkbox" aria-label="全选当前可删除的团队成果" disabled={busy || !deletion.eligible.length} checked={!!deletion.eligible.length && deletion.selected.length === Math.min(100, deletion.eligible.length)} onChange={event => setDeleteSelection(event.target.checked ? deletion.eligible.slice(0, 100).map(item => item.id) : [])}/><span>全选当前可删除项（最多 100 项）</span></label><span>已选择 {deletion.selected.length} 项；切换目录、筛选或刷新后会清空选择</span>{!showHistory && <button className="secondary" disabled={busy || !deletion.selected.length} onClick={() => void move(deletion.selected)}>更改团队路径</button>}<button className="primary danger" disabled={busy || !deletion.selected.length} onClick={() => { setError(''); setPendingDeleteMany(structuredClone(deletion.selected)); }}>删除选中的 {deletion.selected.length} 项</button></section>}
    {resultId && activity && activityChanged && <ActivityResultActions event={activity} item={item && !history.includes(item) ? item : undefined} disabled={busy || editing || attachBusy} changed={async () => { await activityChanged(); await load(); }} notice={notice}/>}
    {resultId ? <div className="content-library single-content-result"><section className="content-detail">
      {item ? <>
        <div className="content-detail-title"><span className="content-category-badge">{categoryLabel(item)}</span><h2>{displayTitle(item)}</h2><ResultAliasEditor alias={{ value: alias(item), original: titleSubject(item.title), save: text => saveAlias(item, text) }} disabled={busy || editing}/></div>
        {renderBody(item, editing)}
        <div className="row">{renderActions(item, editing)}</div>
      </> : <p className="muted">{busy ? '正在读取这条成果…' : error ? '读取失败，请重试。' : '这条成果已删除或被合并，当前结果已不可用。已保存的本地成果仍会保留。'}</p>}
    </section></div> : <div className="content-library result-library"><div className="content-cards">
      {filtered.map(value => { const difference = differences[value.id], historyReason = teamHistoryReason(value); return <ResultCard key={value.id + ':' + value.revision} id={value.id} completed={['completed', 'cancelled'].includes(effectiveResultStatus(value) || '')} title={displayTitle(value)} alias={{ value: alias(value), original: titleSubject(value.title), save: text => saveAlias(value, text) }}
        badges={<><span className="content-category-badge">{categoryLabel(value)}</span>{showHistory && historyReason && <span className={'team-history-badge is-' + historyReason}>{teamHistoryLabels[historyReason]}</span>}{!showHistory && resultStateLabel(value) && <span className="result-state-badge">{resultStateLabel(value)}</span>}{contentFileNotice(value) && <span className="team-result-difference">{value.files?.body === 'missing' || Object.values(value.files?.attachments || {}).includes('missing') ? '关联文件缺失' : '文件待核验'}</span>}{!showHistory && difference && difference !== 'missing' && <span className="team-result-difference">{teamResultDifferenceLabels[difference]}</span>}{!showHistory && !difference && <span className="team-result-difference is-settled">个人库已有</span>}</>}
        metadata={<>{value.resultOwner ? `负责人：${value.resultOwner} · ` : ''}{value.author} · v{value.revision} · {new Date(value.updatedAt).toLocaleString()}{!!value.attachments?.length && ` · ${value.attachments.length} 个附件`}{(folder === 'all' || search.trim()) && <span className="result-directory-path">{resultDirectoryLabel(resultItemFolder(value, directories.directories), directories.directories)}</span>}</>}
        preview={value.deletedAt ? '仅保留删除记录，正文不可用。' : resultPreview(value.description) || '共享文件'} expanded={value.id === selected}
        selected={mergeSelection.includes(value.id) || deleteSelection.includes(value.id)} disabled={editing}
        toggle={() => value.id === selected ? setSelected('') : open(value)}
        selection={selectingDelete ? <label className="content-card-select check-row" title={canDeleteSharedContent(value, username, admin) ? '选择删除' : '无删除权限'}><input type="checkbox" aria-label={`选择删除团队成果：${displayTitle(value)}`} checked={deletion.selected.some(item => item.id === value.id)} disabled={busy || !canDeleteSharedContent(value, username, admin) || !deleteSelection.includes(value.id) && deletion.selected.length >= 100} onChange={event => setDeleteSelection(current => event.target.checked ? [...new Set([...current, value.id])] : current.filter(id => id !== value.id))}/></label> : selectingMerge && value.kind === 'contribution' ? <label className="content-card-select check-row" title={mergeBlockedReason(value) || '加入语义合并'}><input type="checkbox" aria-label={`选择合并：${value.title}`} checked={mergeSelection.includes(value.id)} disabled={!!mergeBlockedReason(value)} onChange={event => toggleMerge(value.id, event.target.checked)}/></label> : undefined}
        notice={selectingMerge && mergeBlockedReason(value) ? mergeBlockedReason(value) : undefined}
        actions={renderActions(value, editing && value.id === selected)}>
        {renderBody(value, editing && value.id === selected)}
      </ResultCard>; })}
      {!filtered.length && <p className="muted">{busy ? '正在比对团队与个人成果…' : !showHistory && !showAll && !visibleItems.length && items.length ? '团队成果与个人库已一致，暂无需要存入的内容。' : hasFilters ? '暂无匹配成果，可清除筛选查看。' : showHistory ? '暂无团队历史' : '暂无团队成果'}</p>}
    </div></div>}
    </section></div>
    {destination.dialog}
    {historyItem && <ResultHistoryDrawer current={{ ...historyItem, version: historyItem.revision, content: historyItem.description }} versions={history.filter(entry => entry.id === historyItem.id).map(entry => ({ ...entry, version: entry.revision, content: entry.description }))} close={() => setHistoryItem(undefined)}/>}
    {attachItem && <div className="modal-backdrop"><section className="modal attach-session-modal" role="dialog" aria-modal="true" aria-labelledby="attach-session-title"><header><h2 id="attach-session-title">选择加入的会话</h2><button className="icon" aria-label="关闭窗口" onClick={() => setAttachItem(undefined)}>×</button></header><div className="modal-body"><p className="attach-source-title">{displayTitle(attachItem)}</p><div className="attach-session-options">{attachSessions.map(session => <label className="attach-session-option" key={session.id}><input type="checkbox" aria-label={`选择会话：${session.title}`} checked={attachSelection.includes(session.id)} disabled={attachBusy} onChange={event => toggleAttach(session.id, event.target.checked)}/><span><b>{session.title}</b><small>{session.provider === 'codex' ? 'Codex' : session.provider === 'claude' ? 'Claude Code' : 'Cursor'}{session.model ? ` · ${session.model}` : ''}</small></span></label>)}</div>{!attachSessions.length && <p className="muted">当前项目没有打开的工作会话，请创建或重新打开一个会话。</p>}</div><footer><button className="secondary" disabled={attachBusy} onClick={() => setAttachItem(undefined)}>取消</button><button className="primary" disabled={attachBusy || !currentAttachSelection.length} onClick={() => void completeAttach()}>{attachBusy ? '正在加入…' : `加入 ${currentAttachSelection.length} 个会话`}</button></footer></section></div>}
    {pendingDelete && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-project-content-title"><header><h2 id="delete-project-content-title">{pendingDelete.supersededBy || pendingDelete.deletedAt ? '确认删除团队历史？' : '确认删除团队成果？'}</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={() => setPendingDelete(undefined)}>×</button></header><div className="modal-body"><p>{pendingDelete.supersededBy || pendingDelete.deletedAt ? `将从团队历史移除“${displayTitle(pendingDelete)}”。` : `将删除团队成果“${displayTitle(pendingDelete)}”。同组成员将无法再从团队成果库查看或引用；正文和历史版本无法从库中恢复。`}</p><p className="muted small">{pendingDelete.supersededBy || pendingDelete.deletedAt ? '这条历史记录对应的正文、附件和会话轨迹，只要没有其他成果继续引用，会一起从共享空间删除。' : '已保存的个人副本、本机整理记录、已发送的对话内容及任务和子会话的固定快照保留。这条成果自己的提交文件、会话轨迹和附件会一并删除；仍被其他成果引用的文件会保留。'}</p>{pendingDelete.provenance?.length ? <p className="merge-safety">删除这条合并成果，不会自动恢复被它替代的来源成果。</p> : !pendingDelete.supersededBy && !pendingDelete.deletedAt ? <p className="muted small">各成员可在删除动态中自行决定是否删除个人副本。</p> : null}{error && <div className="inline-error" role="alert">{error} <ErrorLogLink message={error}/>{checkWriteButton}</div>}</div><footer><button className="secondary" disabled={busy} onClick={() => setPendingDelete(undefined)}>取消</button><button className="primary danger" disabled={busy || uncertainWrite?.value.id === pendingDelete.id} onClick={() => void remove(pendingDelete)}>{busy ? '正在删除…' : pendingDelete.supersededBy || pendingDelete.deletedAt ? '确认删除历史成果' : '确认删除团队成果'}</button></footer></section></div>}
    {pendingReap && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="reap-project-files-title"><header><h2 id="reap-project-files-title">清理未引用文件？</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={() => setPendingReap(false)}>×</button></header><div className="modal-body"><p>只删除这个项目里已经没有任何当前成果或历史成果引用的成员提交、会话轨迹、团队整理文件和附件。</p><p className="muted small">项目说明、任务附件和其他直接放在项目目录中的文件会保留。清理不会删除历史记录本身；要去掉历史条目，请在团队历史里删除。</p>{error && !pendingDelete && !pendingDeleteMany.length && <div className="inline-error" role="alert">{error} <ErrorLogLink message={error}/>{checkWriteButton}</div>}</div><footer><button className="secondary" disabled={busy} onClick={() => setPendingReap(false)}>取消</button><button className="primary danger" disabled={busy} onClick={() => void reap()}>{busy ? '正在清理…' : '确认清理'}</button></footer></section></div>}
    {!!pendingDeleteMany.length && <SharedContentDeleteDialog items={pendingDeleteMany} title={displayTitle} busy={busy} error={error} close={() => setPendingDeleteMany([])} confirm={() => void removeMany()}/>}
  </div>;
}
