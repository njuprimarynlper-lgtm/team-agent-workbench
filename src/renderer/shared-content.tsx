import { resultPreview } from '../shared/result-reading';
import { matchesResultLabel, resultLabels, resultLabelTitle } from '../shared/result-labels';
import { ResultCategoryFilter } from './result-category-filter';
import { ResultCard } from './result-card';
import { teamResultDifference, teamResultDifferenceLabels } from '../shared/team-result-difference';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityResultActions } from './activity-result-actions';
import { SharedAttachments } from './attachments';
import { SharedContentDeleteDialog, sharedDeleteSelection } from './shared-content-delete';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentSession, ConclusionOrganization, ContentUpdate, Draft, Project, ProjectConclusion } from '../shared/types';
import { canDeleteSharedContent, contentAliasKey, titleSubject, type ContentDeleteResult, type SharedContent } from '../shared/content';
export function SharedContentLibrary({ project, username, admin, aliases, aliasSaved, attach, attachSessions, notice, mergeSessions, mergeStarted, focusPath, focusHandled, resultId, returnToUpdates, activity, activityChanged, embedded = false }: { embedded?: boolean; project: Project; username: string; admin: boolean; aliases: Record<string, string>; aliasSaved: () => Promise<void>; attach: (item: SharedContent, sessionIds: string[]) => Promise<void>; attachSessions: AgentSession[]; notice: (text: string) => void; mergeSessions: AgentSession[]; mergeStarted: (draft: Draft) => void; focusPath?: string; focusHandled?: () => void; resultId?: string; returnToUpdates?: () => void; activity?: ContentUpdate; activityChanged?: () => Promise<void> }) {
  const [items, setItems] = useState<SharedContent[]>([]), [search, setSearch] = useState(''), [kind, setKind] = useState('all'), [selected, setSelected] = useState('');
  const [labelFilter, setLabelFilter] = useState('all');
  const [revealedId, setRevealedId] = useState('');
  const [personal, setPersonal] = useState<ProjectConclusion[]>([]), [showAll, setShowAll] = useState(false), [savingId, setSavingId] = useState('');
  const loadSequence = useRef(0), personalSequence = useRef(0);
  const [editing, setEditing] = useState(false), [title, setTitle] = useState(''), [body, setBody] = useState(''), [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [pendingDelete, setPendingDelete] = useState<SharedContent>();
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const [selectingMerge, setSelectingMerge] = useState(false), [mergeSelection, setMergeSelection] = useState<string[]>([]), [mergeSessionId, setMergeSessionId] = useState('');
  const [selectingDelete, setSelectingDelete] = useState(false), [deleteSelection, setDeleteSelection] = useState<string[]>([]), [pendingDeleteMany, setPendingDeleteMany] = useState<SharedContent[]>([]);
  const bulkDeleteRunning = useRef(false);
  const contentScope = useRef(''); contentScope.current = JSON.stringify([project.id, username, admin, resultId]);
  const [attachItem, setAttachItem] = useState<SharedContent>(), [attachSelection, setAttachSelection] = useState<string[]>([]), [attachBusy, setAttachBusy] = useState(false);
  const [aliasItem, setAliasItem] = useState<SharedContent>(), [aliasValue, setAliasValue] = useState('');
  const load = async (resetSelection = true) => {
    const scope = contentScope.current, sequence = ++loadSequence.current, localSequence = ++personalSequence.current; setBusy(true); setBackgroundRefreshing(!resetSelection); if (resetSelection) setDeleteSelection([]);
    try {
      const [items, personal] = await Promise.all([window.workbench.call<SharedContent[]>('content.list', { projectId: project.id }), window.workbench.call<ProjectConclusion[]>('conclusion.list', { projectId: project.id, includeArchived: true })]);
      if (scope !== contentScope.current || sequence !== loadSequence.current) return false;
      setItems(items); if (localSequence === personalSequence.current) setPersonal(personal); setError(''); return true;
    }
    catch (e: any) { if (scope === contentScope.current && sequence === loadSequence.current) setError(e.message); return false; }
    finally { if (scope === contentScope.current && sequence === loadSequence.current) { setBusy(false); setBackgroundRefreshing(false); } }
  };
  useEffect(() => { setItems([]); setPersonal([]); setShowAll(false); setSavingId(''); setSelected(''); setEditing(false); setLabelFilter('all'); setSearch(''); setKind('all'); setSelectingMerge(false); setMergeSelection([]); setAttachItem(undefined); setAttachSelection([]); setPendingDelete(undefined); setAliasItem(undefined); void load(); return () => { loadSequence.current++; personalSequence.current++; }; }, [project.id, username, admin, resultId]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.workbench.subscribe(event => {
      if (event.type !== 'state') return;
      clearTimeout(timer); timer = setTimeout(() => {
        const scope = contentScope.current, sequence = ++personalSequence.current;
        void window.workbench.call<ProjectConclusion[]>('conclusion.list', { projectId: project.id, includeArchived: true }).then(values => { if (scope === contentScope.current && sequence === personalSequence.current) setPersonal(values); }, error => { if (scope === contentScope.current && sequence === personalSequence.current) setError(error.message); });
      }, 150);
    });
    return () => { clearTimeout(timer); unsubscribe(); personalSequence.current++; };
  }, [project.id, username, resultId]);
  useEffect(() => { const timer = setInterval(() => { if (!editing && !busy && !savingId && document.visibilityState === 'visible') void load(false); }, 30000); return () => clearInterval(timer); }, [project.id, username, resultId, editing, busy, savingId]);
  const storePersonal = async (value: SharedContent) => {
    if (savingId || busy) return;
    const scope = contentScope.current; setSavingId(value.id); setError('');
    try {
      const result = await window.workbench.call<ConclusionOrganization>('conclusion.import', { projectId: project.id, contentId: value.id, expectedRevision: value.revision });
      if (scope !== contentScope.current) return;
      // The server has confirmed this copy. Hide that row immediately, even if
      // the following list refresh fails, and leave another expanded row open.
      personalSequence.current++;
      setPersonal(current => [result.conclusion, ...current.filter(item => item.id !== result.conclusion.id)]);
      setSelected(current => current === value.id ? '' : current); setRevealedId(current => current === value.id ? '' : current); const refreshed = await load();
      if (scope !== contentScope.current) return;
      notice(!refreshed ? '已存入个人成果库，列表刷新失败，请点击刷新重试。' : result.action === 'duplicate' ? '个人成果库中已有这条成果；一致内容已从差异列表隐藏。' : '已存入个人成果库；团队原件保留，个人手工修改不会被覆盖。');
    } catch (reason: any) { if (scope === contentScope.current) setError(reason.message); }
    finally { if (scope === contentScope.current) setSavingId(''); }
  };

  useEffect(() => { if (!mergeSessions.some(session => session.id === mergeSessionId)) setMergeSessionId(mergeSessions[0]?.id || ''); }, [mergeSessionId, mergeSessions]);
  useEffect(() => { setSelectingDelete(false); setDeleteSelection([]); setPendingDeleteMany([]); }, [project.id, username, admin, resultId]);
  const item = items.find(i => i.id === (resultId || selected));
  const open = (value: SharedContent) => { setSelected(value.id); setRevealedId(current => current === value.id ? current : ''); setEditing(false); setTitle(value.title); setBody(value.description); setRepo(value.repoUrl || ''); };
  const edit = (value: SharedContent) => { open(value); setEditing(true); };
  useEffect(() => { if (!focusPath) return; const target = items.find(value => value.path === focusPath); if (target) { setLabelFilter('all'); setSearch(''); setKind('all'); setMergeSelection([]); open(target); setRevealedId(target.id); focusHandled?.(); } }, [focusPath, items]);
  // A direct source link may reveal an existing personal copy until it is closed.
  useEffect(() => { if (!selected) setRevealedId(''); }, [selected, project.id, username, admin, resultId]);
  const save = async (action: 'save' | 'delete') => {
    if (!item) return; setBusy(true); setError('');
    try { const savedTitle = title.trim(); await window.workbench.call('content.edit', { projectId: project.id, change: { id: item.id, revision: item.revision, action, title: savedTitle, description: body, repoUrl: repo, curate: admin, merge: [] } }); setEditing(false); await load(); notice(action === 'delete' ? '已从共享区移除' : '团队成果已更新'); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const remove = async (value: SharedContent) => {
    setBusy(true); setError('');
    try {
      await window.workbench.call('content.edit', { projectId: project.id, change: { id: value.id, revision: value.revision, action: 'delete', title: value.title, description: value.description, repoUrl: value.repoUrl || '', curate: admin, merge: [] } });
      if (selected === value.id) setSelected(''); setPendingDelete(undefined); await load(); notice('已从共享区移除；已保存的本地成果不会自动删除');
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const startMerge = async () => {
    if (visibleMergeSelection.length < 2 || !mergeSessionId) return; setBusy(true); setError('');
    try { const draft = await window.workbench.call<Draft>('content.merge.prepare', { projectId: project.id, sessionId: mergeSessionId, sourceIds: visibleMergeSelection }); mergeStarted(draft); }
    catch (e: any) { setError(e.message); }
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
      if (result.error || !refreshed) setError(summary + '。' + (result.uncertainId ? '其中 1 项无法确认是否删除，请先刷新核对。' : '') + (result.error || '列表刷新失败，请重新刷新核对。'));
      notice(summary + '；本地成果和会话引用保留');
    } catch (e: any) { if (scope === contentScope.current) setError(e.message); }
    finally { bulkDeleteRunning.current = false; if (scope === contentScope.current) setBusy(false); }
  };
  const toggleMerge = (id: string, checked: boolean) => setMergeSelection(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id));
  const toggleAttach = (id: string, checked: boolean) => setAttachSelection(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id));
  const completeAttach = async () => {
    if (!attachItem || !attachSelection.length) return;
    setAttachBusy(true); setError('');
    try { await attach(attachItem, attachSelection); setAttachItem(undefined); setAttachSelection([]); }
    catch (e: any) { setError(e.message); }
    finally { setAttachBusy(false); }
  };
  const categoryLabel = (value: SharedContent) => resultLabels(value.title).join(' · ') || (value.kind === 'trajectory' ? '会话轨迹' : value.kind === 'file' ? '共享文件' : '未分类');
  const alias = (value: SharedContent) => aliases[contentAliasKey(project.id, value.id)] || '';
  const displayTitle = (value: SharedContent) => resultLabelTitle(value.title, alias(value));
  const differences = Object.fromEntries(items.map(value => [value.id, teamResultDifference(value, personal)]));
  const visibleItems = admin && showAll ? items : items.filter(value => differences[value.id] || value.id === revealedId);
  const matching = visibleItems.filter(i => (kind === 'all' || i.kind === kind) && [displayTitle(i), i.title, categoryLabel(i), i.description, i.author, i.repoUrl || '', i.createdAt, i.updatedAt, new Date(i.updatedAt).toLocaleDateString()].join(' ').toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const availableKinds = (['contribution', 'file', 'trajectory'] as const).filter(value => visibleItems.some(item => item.kind === value) || kind === value);
  const filtered = matching.filter(i => matchesResultLabel(i.title, labelFilter));
  const visibleMergeSelection = mergeSelection.filter(id => filtered.some(value => value.id === id && value.kind === 'contribution'));
  const hasFilters = search || kind !== 'all' || labelFilter !== 'all';
  const deletion = sharedDeleteSelection(filtered, deleteSelection, username, admin);
  const renderBody = (value: SharedContent, isEditing: boolean) => <>
    {alias(value) && <p className="muted small">本地别名，仅你可见 · 远端标题：{titleSubject(value.title) || value.title}</p>}
    {isEditing ? <>
      <label className="field">标题<input aria-label="团队成果标题" value={title} onChange={e => setTitle(e.target.value)}/><small>标题开头的【标签】用于筛选。</small></label>
      <label className="field">内容 / 说明<textarea aria-label="团队成果内容" rows={14} value={body} onChange={e => setBody(e.target.value)}/></label>
      <label className="field">仓库链接（可选）<input value={repo} onChange={e => setRepo(e.target.value)}/></label>
    </> : <>
      <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:/.test(href)) void window.workbench.call('open.link', href); }}>{children}</a>, img: ({ alt }) => <span>[图片：{alt}]</span> }}>{value.description || '此项为共享文件。'}</ReactMarkdown></div>
      <SharedAttachments key={value.id} item={value} projectId={project.id}/>
      <details className="content-provenance"><summary>来源详情</summary><p>来自：{value.sourceSessionTitle || '手工提交'} · 提交人：{value.author} · 最近维护：{value.updatedBy} · v{value.revision} · 共享给：{project.name}项目组</p>{value.sourceDetails && <pre style={{ whiteSpace: 'pre-wrap' }}>{value.sourceDetails}</pre>}</details>
      {value.provenance?.length ? <details className="content-provenance"><summary>查看融合来源（{value.provenance.length}）</summary>{value.provenance.map(source => <p key={source.id + ':' + source.revision}>{source.title} · {source.author} · v{source.revision} · {new Date(source.updatedAt).toLocaleString()}</p>)}</details> : null}
      {value.repoUrl && <p>仓库：{value.repoUrl}</p>}
      {value.git && <p className="muted small">分支 {value.git.branch} · Commit {value.git.commit || '无'} · {value.git.dirty ? '存在未提交改动' : '无未提交改动'}</p>}
    </>}
  </>;
  const renderActions = (value: SharedContent, isEditing: boolean) => {
    if (isEditing) return <>
      <button className="secondary compact" disabled={busy} onClick={() => open(value)}>取消编辑</button>
      {value.kind !== 'contribution' && <button className="secondary compact" disabled={busy || !title.trim()} onClick={async () => { setBusy(true); try { const saved = await window.workbench.call('content.replace', { projectId: project.id, change: { id: value.id, revision: value.revision, action: 'save', title, description: body, curate: admin } }); if (saved) { setEditing(false); await load(); notice('文件已替换为新修订'); } } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>选择文件并保存替换</button>}
      <button className="primary compact" disabled={busy || !title.trim()} onClick={() => void save('save')}>保存修改</button>
    </>;
    const disabled = busy || editing || !!savingId || selectingMerge || selectingDelete;
    const keepSaveAppearance = backgroundRefreshing && !editing && !savingId && !selectingMerge && !selectingDelete && !!differences[value.id];
    const writable = admin || value.author === username && value.state === 'submitted';
    const maintenance = <>
      <button className="secondary compact" disabled={disabled} onClick={() => edit(value)}>{admin ? '编辑成果' : '修改自己的提交'}</button>
      <button className="secondary compact danger" aria-label={resultId ? undefined : `从共享区移除：${displayTitle(value)}`} disabled={disabled} onClick={() => setPendingDelete(value)}>从共享区移除</button>
    </>;
    return <>
      {!activity && <button className={'primary compact' + (keepSaveAppearance ? ' result-save-refreshing' : '')} aria-label={resultId ? undefined : `存入个人成果库：${displayTitle(value)}`} disabled={disabled || !differences[value.id]} onClick={() => void storePersonal(value)}>{savingId === value.id ? '正在存入…' : differences[value.id] ? '存入个人成果库' : resultId ? '个人库已有此版本' : '个人库已有'}</button>}
      {value.kind !== 'contribution' && <button className="secondary compact" disabled={disabled} onClick={() => void window.workbench.call('remote.download', { projectId: project.id, path: value.path }).catch(e => setError(e.message))}>下载</button>}
      <button className="secondary compact" disabled={disabled} onClick={() => { setAliasItem(value); setAliasValue(alias(value)); }}>设置本地别名</button>
      <button className="secondary compact" disabled={disabled || !attachSessions.length} title={attachSessions.length ? '选择一个或多个会话作为参考资料' : '请先为此项目创建工作会话'} onClick={() => { setAttachItem(value); setAttachSelection([]); }}>加入会话</button>
      {writable && (resultId && !admin ? <details className="activity-own-actions"><summary>管理我的提交</summary><div className="row">{maintenance}</div></details> : maintenance)}
    </>;
  };
  return <div className={(embedded ? 'results-library-pane' : 'workspace-page') + ' team-results' + (resultId ? ' activity-result-page' : '')}>
    {(!embedded || resultId) && <div className="page-title"><div>{!embedded && <span className="eyebrow">TEAM CONTENT</span>}{embedded ? <h2>动态结果</h2> : <h1>{resultId ? '动态结果' : '团队成果'} · {project.name}</h1>}</div>{resultId && <div className="row"><button className="secondary" disabled={busy || editing} onClick={returnToUpdates}>返回动态</button><button className="secondary" disabled={busy || editing} onClick={() => void load()}>刷新</button></div>}</div>}
    {!resultId && <>
      <div className="team-results-toolbar">
        <div className="team-results-summary"><strong>{admin && showAll ? '全部团队成果' : '与个人库有差异'}</strong><span role="status" aria-label="团队成果数量">{busy ? '正在读取…' : filtered.length === visibleItems.length ? `共 ${visibleItems.length} 条` : `显示 ${filtered.length} / 共 ${visibleItems.length} 条`}</span>{admin && <label className="team-results-include"><input type="checkbox" checked={showAll} disabled={busy || editing || !!savingId} onChange={event => { setShowAll(event.target.checked); setLabelFilter('all'); setSearch(''); setKind('all'); setSelected(''); setSelectingMerge(false); setMergeSelection([]); setSelectingDelete(false); setDeleteSelection([]); }}/><span>包含个人库已有成果</span></label>}</div>
        <div className="team-results-actions">
          {admin && <button className="secondary compact" disabled={editing || busy} onClick={() => { setSelectingMerge(!selectingMerge); setMergeSelection([]); setSelectingDelete(false); setDeleteSelection([]); }}>{selectingMerge ? '退出多选' : '多选语义合并'}</button>}
          <button className="secondary compact" aria-label={selectingDelete ? '取消批量删除' : '批量删除团队成果'} disabled={busy || editing || !deletion.eligible.length} onClick={() => { setSelectingDelete(!selectingDelete); setDeleteSelection([]); setSelectingMerge(false); setMergeSelection([]); setError(''); }}>{selectingDelete ? '取消多选' : '批量删除'}</button>
          <button className="secondary compact" disabled={busy || editing} onClick={() => void load()}>刷新</button>
          <details className="team-results-help" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}><summary>使用说明</summary><div className="team-results-help-body">
            <strong className="team-results-help-title">团队与个人成果</strong>
            <dl className="team-results-rules">
              <div><dt>存入个人库</dt><dd>一致版本从默认列表隐藏；移入历史仍算保留。</dd></div>
              <div><dt>删除个人副本</dt><dd>团队原件仍存在时，会重新出现在列表中。</dd></div>
              <div><dt>团队版本更新</dt><dd>重新显示差异。再次存入会保留你的改写，另存团队版本。</dd></div>
              {admin && <div><dt>查看全部</dt><dd>勾选“包含个人库已有成果”显示团队全部原件，仅改变列表范围。</dd></div>}
            </dl>
            {admin && <div className="team-results-help-note">编辑、删除作用于团队原件；语义合并须确认后保存。</div>}
          </div></details>
        </div>
      </div>
      <div className="result-library-filters"><input aria-label="搜索团队成果" placeholder="搜索标题或内容" value={search} disabled={busy || editing} onChange={e => { setSearch(e.target.value); setSelected(''); setDeleteSelection([]); setMergeSelection([]); }}/><ResultCategoryFilter items={visibleItems} label="团队成果类别" value={labelFilter} disabled={busy || editing} onChange={value => { setLabelFilter(value); setSelected(''); setMergeSelection([]); setDeleteSelection([]); }}/>{(availableKinds.length > 1 || kind !== 'all') && <select aria-label="团队成果内容形式" value={kind} disabled={busy || editing} onChange={e => { setKind(e.target.value); setSelected(''); setDeleteSelection([]); setMergeSelection([]); }}><option value="all">全部内容形式</option>{availableKinds.map(value => <option key={value} value={value}>{{ contribution: '文字成果', file: '共享文件', trajectory: '会话轨迹' }[value]}</option>)}</select>}{hasFilters && <button className="team-results-clear" disabled={busy || editing} onClick={() => { setSearch(''); setKind('all'); setLabelFilter('all'); setSelected(''); setDeleteSelection([]); setMergeSelection([]); }}>清除筛选</button>}</div>
    </>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    {admin && !resultId && selectingMerge && <section className="semantic-merge-bar" aria-label="语义合并设置"><div><b>已选择 {visibleMergeSelection.length} 条文字成果</b><small>至少选择 2 条；文件和轨迹不参与语义合并。</small></div>{mergeSessions.length ? <label>使用模型环境<select aria-label="合并使用的模型环境" value={mergeSessionId} onChange={e => setMergeSessionId(e.target.value)}>{mergeSessions.map(session => <option value={session.id} key={session.id}>{session.title} · {session.provider === 'codex' ? 'Codex' : session.provider === 'claude' ? 'Claude Code' : 'Cursor'}{session.model ? ' · ' + session.model : ''}</option>)}</select></label> : <p className="inline-error">请先为此项目创建一个工作会话，用于提供已登录的 AI 模型环境。</p>}<button className="primary" disabled={busy || visibleMergeSelection.length < 2 || !mergeSessionId} onClick={() => void startMerge()}>{busy ? '正在启动…' : `开始语义合并${visibleMergeSelection.length ? `（${visibleMergeSelection.length} 条）` : ''}`}</button></section>}
    {selectingDelete && !resultId && <section className="semantic-merge-bar" aria-label="团队成果批量删除设置"><label className="check-row"><input type="checkbox" aria-label="全选当前可删除的团队成果" disabled={busy || !deletion.eligible.length} checked={!!deletion.eligible.length && deletion.selected.length === Math.min(100, deletion.eligible.length)} onChange={event => setDeleteSelection(event.target.checked ? deletion.eligible.slice(0, 100).map(item => item.id) : [])}/><span>全选当前可删除项（最多 100 项）</span></label><span>已选择 {deletion.selected.length} 项；切换分组、筛选或刷新后会清空选择</span><button className="primary danger" disabled={busy || !deletion.selected.length} onClick={() => { setError(''); setPendingDeleteMany(structuredClone(deletion.selected)); }}>删除选中的 {deletion.selected.length} 项</button></section>}
    {resultId && activity && activityChanged && <ActivityResultActions event={activity} item={item} disabled={busy || editing || attachBusy} changed={async () => { await activityChanged(); await load(); }} notice={notice}/>}
    {resultId ? <div className="content-library single-content-result"><section className="content-detail">
      {item ? <>
        <div className="content-detail-title"><span className="content-category-badge">{categoryLabel(item)}</span><h2>{displayTitle(item)}</h2></div>
        {renderBody(item, editing)}
        <div className="row">{renderActions(item, editing)}</div>
      </> : <p className="muted">{busy ? '正在读取这条成果…' : error ? '读取失败，请重试。' : '这条成果已删除或被合并，当前结果已不可用。已保存的本地成果仍会保留。'}</p>}
    </section></div> : <div className="content-library result-library"><div className="content-cards">
      {filtered.map(value => <ResultCard key={value.id} id={value.id} title={displayTitle(value)}
        badges={<><span className="content-category-badge">{categoryLabel(value)}</span><span className="team-result-difference">{differences[value.id] ? teamResultDifferenceLabels[differences[value.id]!] : '个人库已有此版本'}</span></>}
        metadata={<>{value.author} · v{value.revision} · {new Date(value.updatedAt).toLocaleString()}{!!value.attachments?.length && ` · ${value.attachments.length} 个附件`}</>}
        preview={resultPreview(value.description) || '共享文件'} expanded={value.id === selected}
        selected={mergeSelection.includes(value.id) || deleteSelection.includes(value.id)} disabled={editing}
        toggle={() => value.id === selected ? setSelected('') : open(value)}
        selection={selectingDelete ? <label className="content-card-select check-row" title={canDeleteSharedContent(value, username, admin) ? '选择删除' : '无删除权限'}><input type="checkbox" aria-label={`选择删除团队成果：${displayTitle(value)}`} checked={deletion.selected.some(item => item.id === value.id)} disabled={busy || !canDeleteSharedContent(value, username, admin) || !deleteSelection.includes(value.id) && deletion.selected.length >= 100} onChange={event => setDeleteSelection(current => event.target.checked ? [...new Set([...current, value.id])] : current.filter(id => id !== value.id))}/></label> : selectingMerge && value.kind === 'contribution' ? <label className="content-card-select check-row" title="加入语义合并"><input type="checkbox" aria-label={`选择合并：${value.title}`} checked={mergeSelection.includes(value.id)} disabled={busy} onChange={event => toggleMerge(value.id, event.target.checked)}/></label> : undefined}
        actions={renderActions(value, editing && value.id === selected)}>
        {renderBody(value, editing && value.id === selected)}
      </ResultCard>)}
      {!filtered.length && <p className="muted">{busy ? '正在比对团队与个人成果…' : !showAll && !visibleItems.length && items.length ? '团队成果与个人库已一致，暂无需要存入的内容。' : hasFilters ? '暂无匹配成果，可清除筛选查看。' : '暂无团队成果'}</p>}
    </div></div>}
    {attachItem && <div className="modal-backdrop"><section className="modal attach-session-modal" role="dialog" aria-modal="true" aria-labelledby="attach-session-title"><header><h2 id="attach-session-title">选择加入的会话</h2><button className="icon" aria-label="关闭窗口" onClick={() => setAttachItem(undefined)}>×</button></header><div className="modal-body"><p className="attach-source-title">{displayTitle(attachItem)}</p><div className="attach-session-options">{attachSessions.map(session => <label className="attach-session-option" key={session.id}><input type="checkbox" aria-label={`选择会话：${session.title}`} checked={attachSelection.includes(session.id)} disabled={attachBusy} onChange={event => toggleAttach(session.id, event.target.checked)}/><span><b>{session.title}</b><small>{session.provider === 'codex' ? 'Codex' : session.provider === 'claude' ? 'Claude Code' : 'Cursor'}{session.model ? ` · ${session.model}` : ''}</small></span></label>)}</div></div><footer><button className="secondary" disabled={attachBusy} onClick={() => setAttachItem(undefined)}>取消</button><button className="primary" disabled={attachBusy || !attachSelection.length} onClick={() => void completeAttach()}>{attachBusy ? '正在加入…' : `加入 ${attachSelection.length} 个会话`}</button></footer></section></div>}
    {aliasItem && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="content-alias-title"><header><h2 id="content-alias-title">设置本地别名</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={() => setAliasItem(undefined)}>×</button></header><div className="modal-body"><p className="muted small">别名只作用于你的账号，可随账号同步；不修改共享标题，其他成员看不到。</p><label className="field">本地别名<input autoFocus aria-label="项目成果本地别名" maxLength={200} value={aliasValue} placeholder={titleSubject(aliasItem.title) || aliasItem.title} onChange={event => setAliasValue(event.target.value)}/></label><p className="muted small">远端标题：{titleSubject(aliasItem.title) || aliasItem.title}</p></div><footer>{alias(aliasItem) && <button className="secondary danger" disabled={busy} onClick={() => void (async () => { setBusy(true); try { await window.workbench.call('content.alias.save', { projectId: project.id, contentId: aliasItem.id, alias: '' }); await aliasSaved(); setAliasItem(undefined); notice('本地别名已清除'); } catch (e: any) { setError(e.message); } finally { setBusy(false); } })()}>清除别名</button>}<span className="spacer"/><button className="secondary" disabled={busy} onClick={() => setAliasItem(undefined)}>取消</button><button className="primary" disabled={busy || !aliasValue.trim()} onClick={() => void (async () => { setBusy(true); try { await window.workbench.call('content.alias.save', { projectId: project.id, contentId: aliasItem.id, alias: aliasValue }); await aliasSaved(); setAliasItem(undefined); notice('本地别名已保存，不会修改远端标题'); } catch (e: any) { setError(e.message); } finally { setBusy(false); } })()}>{busy ? '正在保存…' : '保存本地别名'}</button></footer></section></div>}
    {pendingDelete && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-project-content-title"><header><h2 id="delete-project-content-title">确认从共享区移除？</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={() => setPendingDelete(undefined)}>×</button></header><div className="modal-body"><p>将从共享区移除“{displayTitle(pendingDelete)}”，同组成员将无法再从共享区查看或引用这条内容。</p><p className="muted small">已保存的本地成果会保留，每位成员可在删除动态中自行选择是否删除本地副本。</p>{pendingDelete.provenance?.length ? <p className="merge-safety">这是综合整理结果。删除后，之前被融合的来源不会自动恢复；本机的整理记录仍会保留。</p> : <p className="muted small">本机的整理记录不会随公共文档一起删除。</p>}</div><footer><button className="secondary" disabled={busy} onClick={() => setPendingDelete(undefined)}>取消</button><button className="primary danger" disabled={busy} onClick={() => void remove(pendingDelete)}>{busy ? '正在移除…' : '确认移除'}</button></footer></section></div>}
    {!!pendingDeleteMany.length && <SharedContentDeleteDialog items={pendingDeleteMany} title={displayTitle} busy={busy} error={error} close={() => setPendingDeleteMany([])} confirm={() => void removeMany()}/>}
  </div>;
}
