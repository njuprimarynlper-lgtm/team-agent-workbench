import React, { useState } from 'react';
import { Archive, BellRing, Combine, FileUp, Pencil, Trash2 } from 'lucide-react';
import type { ConclusionOrganization, ContentUpdate, ContentUpdateAction, ProjectConclusion } from '../shared/types';
import { conclusionTitle } from '../shared/conclusion-context';
import { contentAliasKey, contributionCategoryInfo, contributionTitle, titleSubject, type SharedContent } from '../shared/content';

const changeInfo = {
  new: { label: '上传成果', detail: '新增到团队公共区', icon: FileUp },
  updated: { label: '更新成果', detail: '已有内容发布了新修订', icon: Pencil },
  deleted: { label: '共享区已移除', detail: '这条内容已从共享区移除，已保存的项目资料不会自动删除', icon: Trash2 },
  merged: { label: '合并成果', detail: '多条来源已融合为统一结果', icon: Combine }
} as const;

function actionLabel(action: ContentUpdateAction, event: ContentUpdate) {
  const name = action.targetTitle ? `：“${action.targetTitle}”` : '';
  if (action.sourceRevision !== undefined && action.sourceRevision > event.revision) {
    if (action.kind === 'saved_conclusion') return '已加入更新后的成果' + name;
    if (action.kind === 'attached_session') return '已将更新后的成果加入会话' + name;
  }
  return ({ saved_conclusion: '已加入项目资料', attached_session: '已加入会话', kept_conclusion: '已保留项目资料', deleted_conclusion: '已删除项目资料', acknowledged: '已确认，本机无对应结论', archived: '已标记处理' } as const)[action.kind] + name;
}

export function ContentActionRecord({ action, event }: { action: ContentUpdateAction; event: ContentUpdate }) {
  const newer = action.sourceRevision !== undefined && action.sourceRevision > event.revision;
  return <><span>{actionLabel(action, event)}{action.sourceRevision !== undefined && <small> · 第 {action.sourceRevision} 版{newer ? `（此动态记录的是第 ${event.revision} 版）` : ''}</small>}
    {action.sourceTitle && action.targetTitle && titleSubject(action.sourceTitle) !== titleSubject(action.targetTitle) && <small> · 来源成果：“{action.sourceTitle}”</small>}
    {action.correctedFromTitle && <details><summary>已纠正旧版自动归并</summary>已恢复为独立项目资料。原资料“{action.correctedFromTitle}”的正文和会话引用保持不变。</details>}
  </span><time>{new Date(action.at).toLocaleString()}</time></>;
}

export function UpdatedContentConfirmation({ original, latest, busy, confirm, close, view }: { original: ContentUpdate; latest: ContentUpdate; busy: boolean; confirm: () => void; close: () => void; view: () => void }) {
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="updated-content-title">
    <header><h2 id="updated-content-title">这条成果已经更新</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}>×</button></header>
    <div className="modal-body"><p>这条动态记录的是第 {original.revision} 版：“{titleSubject(original.title)}”。</p><p>当前共享成果是第 {latest.revision} 版：“{titleSubject(latest.title)}”。</p><p>确认后加入的是更新后的内容。</p></div>
    <footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="secondary" disabled={busy} onClick={view}>查看更新后的结果</button><button className="primary" disabled={busy} onClick={confirm}>将第 {latest.revision} 版加入项目资料</button></footer>
  </section></div>;
}

export function ContentUpdatesPanel({ updates, aliases, apply, view, deletionResolved }: { updates: ContentUpdate[]; aliases: Record<string, string>; apply: (item: ContentUpdate) => Promise<ConclusionOrganization | undefined>; view: (item: ContentUpdate) => void; deletionResolved: () => Promise<void> }) {
  const [scope, setScope] = useState<'pending' | 'history' | 'all'>('pending'), [filter, setFilter] = useState<'all' | ContentUpdate['change']>('all'), [busy, setBusy] = useState('');
  const [deletion, setDeletion] = useState<{ event: ContentUpdate; conclusions: ProjectConclusion[] }>(), [removeIds, setRemoveIds] = useState<string[]>([]), [error, setError] = useState('');
  const [selectingDelete, setSelectingDelete] = useState(false), [selectedEvents, setSelectedEvents] = useState<string[]>([]), [pendingDelete, setPendingDelete] = useState<ContentUpdate[]>([]);
  const [updatedContent, setUpdatedContent] = useState<{ original: ContentUpdate; latest: ContentUpdate }>();
  const eventTitle = (item: ContentUpdate) => aliases[contentAliasKey(item.projectId, item.id)] || titleSubject(item.title) || item.title;
  const deleteEvents = async () => {
    if (!pendingDelete.length) return; setBusy('delete-events'); setError('');
    try {
      await window.workbench.call('content.updates.delete', { eventIds: pendingDelete.map(item => item.eventId) });
      await deletionResolved(); setPendingDelete([]); setSelectedEvents([]); setSelectingDelete(false);
    } catch (e: any) { setError(e.message); } finally { setBusy(''); }
  };
  const reviewDeletion = async (item: ContentUpdate) => {
    setBusy(item.eventId); setError('');
    try { const conclusions = await window.workbench.call<ProjectConclusion[]>('content.deletion.conclusions', { eventId: item.eventId }); setDeletion({ event: item, conclusions }); setRemoveIds([]); }
    catch (e: any) { setError(e.message); } finally { setBusy(''); }
  };
  const resolveDeletion = async (remove: boolean) => {
    if (!deletion) return; setBusy(deletion.event.eventId); setError('');
    try {
      await window.workbench.call('content.deletion.resolve', { eventId: deletion.event.eventId, selections: remove ? deletion.conclusions.filter(item => removeIds.includes(item.id)).map(item => ({ id: item.id, version: item.version })) : [] });
      await deletionResolved(); setDeletion(undefined);
    } catch (e: any) { setError(e.message); } finally { setBusy(''); }
  };
  const scoped = updates.filter(item => scope === 'all' || (scope === 'history' ? !!item.readAt : !item.readAt)), visible = scoped.filter(item => filter === 'all' || item.change === filter);
  const selectedVisible = visible.filter(item => selectedEvents.includes(item.eventId));
  const unread = updates.filter(item => !item.readAt).length, counts = (change: ContentUpdate['change']) => scoped.filter(item => item.change === change).length;
  const organize = async (item: ContentUpdate, confirmed = false) => {
    setBusy(item.eventId); setError('');
    try {
      if (!confirmed) {
        const latest = (await window.workbench.call<SharedContent[]>('content.list', { projectId: item.projectId })).find(value => value.id === item.id);
        if (!latest) throw new Error('这条成果已从共享区移除，请刷新动态');
        if (latest.revision !== item.revision) {
          setUpdatedContent({ original: item, latest: { ...item, title: latest.title, revision: latest.revision, path: latest.path, category: latest.category } }); return;
        }
      }
      setUpdatedContent(undefined); await apply(item);
    } catch (e: any) { setError(e.message); } finally { setBusy(''); }
  };
  return <div className="workspace-page updates-page">
    <div className="page-title updates-heading"><div><span className="eyebrow">TEAM ACTIVITY</span><h1>团队动态</h1><p className="muted small">这里记录公共区发生过的变化，包括自己的操作；队友的变化和需要处理个人副本的删除进入待处理，其他自己的操作进入历史。“查看结果”打开这条成果的当前版本。“加入项目资料”保存到你的个人资料，不会发布到团队共享区。共享区删除后，项目资料仍会保留，由你选择是否删除个人副本。</p></div></div>
    {error && !deletion && !pendingDelete.length && <div className="inline-error" role="alert">{error}</div>}
    <div className="updates-scope" role="tablist" aria-label="动态范围"><button role="tab" aria-selected={scope === 'pending'} className={scope === 'pending' ? 'active' : ''} onClick={() => { setScope('pending'); setSelectedEvents([]); }}>待处理 {unread}</button><button role="tab" aria-selected={scope === 'history'} className={scope === 'history' ? 'active' : ''} onClick={() => { setScope('history'); setSelectedEvents([]); }}>历史动态 {updates.filter(item => item.readAt).length}</button><button role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'active' : ''} onClick={() => { setScope('all'); setSelectedEvents([]); }}>全部动态 {updates.length}</button></div>
    <section className="update-summary" aria-label="团队动态概览">
      {(['new', 'updated', 'merged', 'deleted'] as const).map(change => { const InfoIcon = changeInfo[change].icon; return <button key={change} className={filter === change ? 'active' : ''} onClick={() => { setFilter(filter === change ? 'all' : change); setSelectedEvents([]); }}><InfoIcon size={20}/><span><b>{counts(change)}</b><small>{changeInfo[change].label}</small></span></button>; })}
    </section>
    <div className="updates-toolbar">{filter !== 'all' && <button className="text-button" onClick={() => { setFilter('all'); setSelectedEvents([]); }}>清除类型筛选</button>}<button className="secondary danger" disabled={!!busy} onClick={() => { setSelectingDelete(!selectingDelete); setSelectedEvents([]); setError(''); }}>{selectingDelete ? '取消多选' : '批量删除动态'}</button></div>
    {selectingDelete && <section className="semantic-merge-bar" aria-label="批量删除动态设置"><label className="check-row"><input type="checkbox" aria-label="全选当前动态" disabled={!!busy || !visible.length} checked={!!visible.length && selectedVisible.length === visible.length} onChange={event => setSelectedEvents(event.target.checked ? visible.map(item => item.eventId) : [])}/><span>全选当前列表（{visible.length} 条）</span></label><span>已选择 {selectedVisible.length} 条</span><button className="secondary danger" disabled={!!busy || !selectedVisible.length} onClick={() => { setPendingDelete(selectedVisible); setError(''); }}>删除选中的 {selectedVisible.length} 条动态</button></section>}
    <section className="update-feed" aria-label="团队动态列表">
      {visible.map(item => { const info = changeInfo[item.change], InfoIcon = info.icon, category = item.category ? contributionCategoryInfo[item.category].label : item.change === 'merged' ? '综合整理' : '项目内容', remoteTitle = titleSubject(item.title) || item.title, localAlias = aliases[contentAliasKey(item.projectId, item.id)], displayTitle = item.category ? contributionTitle(item.category, localAlias || remoteTitle) : localAlias || remoteTitle; return <article className={'update-entry ' + (!item.readAt ? 'unread' : '') + (selectingDelete ? ' selecting-delete' : '')} key={item.eventId}>
        {selectingDelete && <label className="check-row"><input type="checkbox" aria-label={`选择删除动态：${eventTitle(item)}`} checked={selectedEvents.includes(item.eventId)} disabled={!!busy} onChange={event => setSelectedEvents(current => event.target.checked ? [...new Set([...current, item.eventId])] : current.filter(id => id !== item.eventId))}/></label>}
        <div className={'update-icon ' + item.change}><InfoIcon size={20}/></div>
        <div className="update-entry-body"><header><span className={'update-type ' + item.change}>{info.label}</span><span className="content-category-badge">{category}</span><span className="muted small">v{item.revision}</span><span className={'badge ' + (item.readAt ? 'done' : 'running')}>{item.actions?.length ? '已处理' : item.readAt ? '已归档' : '待处理'}</span><time>{new Date(item.occurredAt).toLocaleString()}</time></header><h2>{displayTitle}</h2>{localAlias && <p className="muted small">公共区原名：{remoteTitle}</p>}<p>{item.updatedBy ? `${item.updatedBy} · ` : ''}{item.projectName} · {info.detail}{item.author ? ` · 原提交人 ${item.author}` : ''}{item.sourceSessionTitle ? ` · 来源会话“${item.sourceSessionTitle}”` : ''}</p>{item.change === 'merged' && item.sourceTitles?.length ? <details><summary>查看被融合的来源（{item.sourceTitles.length}）</summary><ul>{item.sourceTitles.map((title, index) => <li key={title + index}>{title}</li>)}</ul></details> : null}{item.unavailableAt && <p className="update-processing-note">原成果已从共享区移除；个人副本、会话引用和处理记录保留。</p>}{item.actions?.length ? <ul className="update-processing" aria-label="我的处理记录">{item.actions.map((action, index) => <li key={index}><ContentActionRecord action={action} event={item}/></li>)}</ul> : item.readAt ? <p className="update-processing-note">{item.archiveReason === 'own_change' ? '我发起的共享区操作，已自动归档；尚未记录加入项目资料或会话。' : '已归档；旧记录未保存具体处理方式。'}</p> : null}</div>
        <div className="update-entry-actions">{item.change !== 'deleted' && !item.unavailableAt && <><button className="secondary compact" onClick={() => view(item)}>查看结果</button><button className="primary compact" disabled={!!busy} onClick={() => void organize(item)}>{busy === item.eventId ? '正在加入…' : '加入项目资料'}</button></>}{item.change === 'deleted' && <button className="secondary compact" disabled={!!busy} onClick={() => void reviewDeletion(item)}>{busy === item.eventId ? '正在读取…' : '选择是否保留项目资料'}</button>}</div>
      </article>; })}
      {!visible.length && <div className="page-empty"><BellRing size={38}/><h2>{scope === 'pending' ? '没有待处理动态' : scope === 'history' ? '暂无历史动态' : '暂无动态记录'}</h2><p>{scope === 'pending' ? '新的团队成果变化会出现在这里。' : '连接共享空间后，团队公共成果的变化会保存在这里。'}</p></div>}
    </section>
    {updatedContent && <UpdatedContentConfirmation {...updatedContent} busy={!!busy} close={() => setUpdatedContent(undefined)} confirm={() => void organize(updatedContent.latest, true)} view={() => { view(updatedContent.latest); setUpdatedContent(undefined); }}/>}
    {pendingDelete.length > 0 && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-events-title">
      <header><h2 id="delete-events-title">删除所选动态？</h2><button className="icon" aria-label="关闭窗口" disabled={!!busy} onClick={() => setPendingDelete([])}>×</button></header>
      <div className="modal-body"><p>将从本机删除以下 {pendingDelete.length} 条动态记录。</p><ul className="delete-selection-list">{pendingDelete.map(item => <li key={item.eventId}>{eventTitle(item)} · {changeInfo[item.change].label} · v{item.revision} · {item.projectName}</li>)}</ul><p className="muted small">只清除动态记录，共享区内容、项目资料和会话引用会继续保留。后续有新的内容变化时，仍会收到新动态。</p>{error && <div className="inline-error" role="alert">{error}</div>}</div>
      <footer><button className="secondary" disabled={!!busy} onClick={() => setPendingDelete([])}>取消</button><button className="primary danger" disabled={!!busy} onClick={() => void deleteEvents()}>{busy ? '正在删除…' : `确认删除 ${pendingDelete.length} 条动态`}</button></footer>
    </section></div>}
    {deletion && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="local-deletion-title">
      <header><h2 id="local-deletion-title">是否保留项目资料？</h2><button className="icon" aria-label="关闭窗口" disabled={!!busy} onClick={() => setDeletion(undefined)}>×</button></header>
      <div className="modal-body"><p>已从共享区移除：{aliases[contentAliasKey(deletion.event.projectId, deletion.event.id)] || titleSubject(deletion.event.title) || deletion.event.title}</p>
        {error && <div className="inline-error" role="alert">{error}</div>}
        {deletion.conclusions.length ? <><p className="muted small">这些项目资料目前仍然保留。只会删除你明确勾选的条目；包含多个来源的结论会整条删除。已加入会话的快照会继续保留。</p>
          <div className="conclusion-match-list">{deletion.conclusions.map(item => <div className="local-deletion-option" key={item.id}><label className="check-row"><input type="checkbox" aria-label={`删除项目资料：${conclusionTitle(item)}`} checked={removeIds.includes(item.id)} disabled={!!busy} onChange={event => setRemoveIds(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))}/><span><b>{conclusionTitle(item)}</b><small>v{item.version} · {item.sources.length} 个来源{item.sources.length > 1 ? ' · 含其他来源，请确认后选择' : ''}{item.archived ? ' · 历史结论' : ''}</small></span></label><details><summary>查看内容与来源</summary><p className="local-deletion-content">{item.content}</p>{item.sources.map((source, index) => <p className="muted small" key={index}>{source.title}</p>)}</details></div>)}</div>
        </> : <p>本地没有保存这条成果对应的结论。</p>}
      </div><footer><button className="secondary" disabled={!!busy} onClick={() => setDeletion(undefined)}>稍后处理</button><button className="primary" disabled={!!busy} onClick={() => void resolveDeletion(false)}><Archive size={13}/>{deletion.conclusions.length ? '保留全部项目资料' : '知道了'}</button>{deletion.conclusions.length > 0 && <button className="secondary danger" disabled={!!busy || !removeIds.length} onClick={() => void resolveDeletion(true)}>删除选中的 {removeIds.length} 条项目资料</button>}</footer>
    </section></div>}
  </div>;
}
