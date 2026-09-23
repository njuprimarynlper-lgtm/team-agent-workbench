import React, { useEffect, useState } from 'react';
import { contributionCategoryInfo, materialCategories } from '../shared/content';
import { resultCategoryBoundaries, resultPreferencesSchema, resultPresets, temporaryCombinationId, temporaryResultCombination, type ResultCombination, type ResultRulesState } from '../shared/result-rules';

export function ResultRulesEditor({ projectId, projectName, initialState, saved, temporary, appliedTemporary }: {
  projectId: string; projectName: string; initialState?: ResultRulesState; saved?: (state: ResultRulesState) => void;
  temporary?: ResultCombination; appliedTemporary?: (combination: ResultCombination) => void;
}) {
  const [data, setData] = useState(initialState), [form, setForm] = useState<ResultCombination | undefined>(temporary || initialState?.combination);
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(!initialState), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const isTemporary = form?.id === temporaryCombinationId;
  const editable = editing || isTemporary;
  const creating = editing && !data?.preferences.combinations.some(item => item.id === form?.id);
  useEffect(() => {
    let active = true; setBusy(true); setError('');
    void window.workbench.call<ResultRulesState>('result.rules', { projectId }).then(result => {
      if (active) { setData(result); setForm(temporary || result.combination); setEditing(false); }
    }, reason => { if (active) setError(reason.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [projectId]);
  const choose = (id: string) => {
    if (!data || !form) return;
    setError(''); setNotice(''); setEditing(id === 'new');
    if (id === 'new') setForm({ ...structuredClone(form), id: crypto.randomUUID(), name: '' });
    else if (id === temporaryCombinationId) setForm({ id, name: '临时组合', categories: [...form.categories] });
    else {
      const next = [...resultPresets, ...data.preferences.combinations].find(item => item.id === id);
      if (next) setForm(structuredClone(next));
    }
  };
  const save = async (removeId?: string) => {
    if (!data || !form || busy || isTemporary) return; setBusy(true); setError(''); setNotice('');
    try {
      let combinations = data.preferences.combinations.filter(item => item.id !== removeId);
      if (editing && !removeId) combinations = [...combinations.filter(item => item.id !== form.id), form];
      const preferences = resultPreferencesSchema.parse({ combinations, projects: removeId ? data.preferences.projects : { ...data.preferences.projects, [projectId]: form.id } });
      const result = await window.workbench.call<ResultRulesState>('result.rules.save', { projectId, owner: data.owner, version: data.version, preferences });
      setData(result); setForm(result.combination); setEditing(false); setNotice(removeId ? '组合已删除' : '已保存，后续整理使用这套分类'); saved?.(result);
    } catch (reason: any) { setError(reason.issues?.map((issue: { message: string }) => issue.message).join('；') || reason.message); } finally { setBusy(false); }
  };
  const apply = () => {
    if (!form || busy) return;
    if (!isTemporary) { void save(); return; }
    try { appliedTemporary?.(temporaryResultCombination(form.categories)); }
    catch (reason: any) { setError(reason.issues?.map((issue: { message: string }) => issue.message).join('；') || reason.message); }
  };
  return <><div className="modal-body result-rules-editor">
    <h3>整理分类组合 · {projectName}</h3>
    <p className="muted small">{isTemporary ? '临时组合仅用于这一次整理，不保存为个人组合，也不修改项目默认设置。' : '保存的组合随个人账号同步，影响使用它的项目后续整理和手动填写；不改变其他成员的设置、旧成果或已有会话内容。'}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {data && form && <>
      <label className="field">{appliedTemporary ? '选择分类组合' : '当前项目使用的组合'}
        <select aria-label="成果分类组合" disabled={busy} value={creating ? 'new' : form.id} onChange={event => choose(event.target.value)}>
          <optgroup label="预设组合">{resultPresets.map(item => <option key={item.id} value={item.id}>{item.name}（预设）</option>)}</optgroup>
          {!!data.preferences.combinations.length && <optgroup label="我的组合">{data.preferences.combinations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>}
          <optgroup label="更多选项">{appliedTemporary && <option value={temporaryCombinationId}>临时组合（仅本次，不保存）</option>}<option value="new">新建组合…</option></optgroup>
        </select>
      </label>
      {!isTemporary && <div className="row">{editing ? <button className="secondary" disabled={busy} onClick={() => { setForm(data.combination); setEditing(false); setError(''); }}>取消编辑</button> : data.preferences.combinations.some(item => item.id === form.id) && <button className="secondary" disabled={busy} onClick={() => { setForm(structuredClone(form)); setEditing(true); setNotice(''); }}>编辑组合</button>}</div>}
      {editing && <><label className="field">组合名称<input autoFocus aria-label="组合名称" maxLength={30} placeholder="例如：算法比赛、客户端开发" disabled={busy} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })}/></label><p className="muted small">{creating ? '新组合保存后可在其他项目中复用。' : '修改组合会影响你所有使用它的项目，仅影响后续整理。'}</p></>}
      <p className="muted small">{isTemporary ? '勾选本次需要的类别，无需命名。关闭整理窗口后恢复项目默认组合。' : editing ? '选择这个组合包含的类别。类别可在不同组合中重复使用。' : '可在上方下拉菜单中新建组合，调整所含类别。'}每次最多 5 条，不凑数；本机环境故障不整理。</p>
      <div className="result-category-grid">{materialCategories.map(category => { const boundary = resultCategoryBoundaries[category]; return <section key={category} className="result-category-option"><label className="check-row"><input type="checkbox" aria-label={`启用${contributionCategoryInfo[category].label}`} disabled={busy || !editable} checked={form.categories.includes(category)} onChange={event => setForm({ ...form, categories: event.target.checked ? [...form.categories, category] : form.categories.filter(item => item !== category) })}/><span><b>{contributionCategoryInfo[category].label}</b><small>{boundary.question}</small></span></label><details><summary>收录边界</summary><p>{boundary.include}</p><p className="muted small">{boundary.exclude}</p></details></section>; })}</div>
      {!!data.preferences.combinations.length && <details><summary>管理我的组合</summary>{data.preferences.combinations.map(item => { const used = Object.values(data.preferences.projects).filter(id => id === item.id).length; return <div className="row" key={item.id}><span>{item.name} · {used ? `${used} 个项目使用中` : '未使用'}</span><button className="text-button danger" disabled={busy || editable || !!used} title={used ? '请先为使用中的项目切换其他组合并保存' : '删除未使用的组合'} onClick={() => void save(item.id)}>删除</button></div>; })}</details>}
    </>}
  </div><footer><button className="primary" disabled={busy || !form || !form.name.trim() || !form.categories.length} onClick={apply}>{busy ? '正在读取或保存…' : isTemporary ? '用于本次整理' : '保存并用于当前项目'}</button></footer></>;
}
