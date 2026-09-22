import React, { useEffect, useState } from 'react';
import { contributionCategoryInfo, materialCategories } from '../shared/content';
import { resultCategoryBoundaries, resultPreferencesSchema, resultPresets, type ResultCombination, type ResultRulesState } from '../shared/result-rules';

export function ResultRulesEditor({ projectId, projectName, initialState, saved }: { projectId: string; projectName: string; initialState?: ResultRulesState; saved?: () => void }) {
  const [data, setData] = useState(initialState), [form, setForm] = useState<ResultCombination | undefined>(initialState?.combination);
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(!initialState), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true; setBusy(true); setError('');
    void window.workbench.call<ResultRulesState>('result.rules', { projectId }).then(result => { if (active) { setData(result); setForm(result.combination); setEditing(false); } }, reason => { if (active) setError(reason.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [projectId]);
  const save = async (removeId?: string) => {
    if (!data || !form || busy) return; setBusy(true); setError(''); setNotice('');
    try {
      let combinations = data.preferences.combinations.filter(item => item.id !== removeId);
      if (editing && !removeId) combinations = [...combinations.filter(item => item.id !== form.id), form];
      const preferences = resultPreferencesSchema.parse({ combinations, projects: removeId ? data.preferences.projects : { ...data.preferences.projects, [projectId]: form.id } });
      const result = await window.workbench.call<ResultRulesState>('result.rules.save', { projectId, owner: data.owner, version: data.version, preferences });
      setData(result); setForm(result.combination); setEditing(false); setNotice(removeId ? '组合已删除' : '已保存，后续整理使用这套分类'); saved?.();
    } catch (reason: any) { setError(reason.issues?.map((issue: { message: string }) => issue.message).join('；') || reason.message); } finally { setBusy(false); }
  };
  return <><div className="modal-body result-rules-editor">
    <h3>我的成果分类 · {projectName}</h3><p className="muted small">仅影响你在这个项目中的后续整理和手动填写，随个人账号同步；不改变其他成员的设置、旧成果或已有会话内容。</p>
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {data && form && <>
      <label className="field">当前项目使用的组合<select aria-label="成果分类组合" disabled={busy || editing} value={form.id} onChange={event => { const next = [...resultPresets, ...data.preferences.combinations].find(item => item.id === event.target.value)!; setForm(structuredClone(next)); setNotice(''); }}>{editing && !data.preferences.combinations.some(item => item.id === form.id) && <option value={form.id}>新建组合</option>}{[...resultPresets, ...data.preferences.combinations].map(item => <option key={item.id} value={item.id}>{item.name}{resultPresets.some(preset => preset.id === item.id) ? '（预设）' : ''}</option>)}</select></label>
      <div className="row">{!editing ? <><button className="secondary" disabled={busy} onClick={() => { setForm({ ...structuredClone(form), id: crypto.randomUUID(), name: '' }); setEditing(true); setNotice(''); }}>新建组合</button>{data.preferences.combinations.some(item => item.id === form.id) && <button className="secondary" disabled={busy} onClick={() => { setForm(structuredClone(form)); setEditing(true); setNotice(''); }}>编辑组合</button>}</> : <button className="secondary" disabled={busy} onClick={() => { setForm(data.combination); setEditing(false); }}>取消编辑</button>}</div>
      {editing && <><label className="field">组合名称<input autoFocus aria-label="组合名称" maxLength={30} placeholder="例如：算法比赛、客户端开发" disabled={busy} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })}/></label><p className="muted small">修改组合会影响你所有使用它的项目，仅影响后续整理。</p></>}
      <p className="muted small">{editing ? '选择这个组合包含的类别。类别可在不同组合中重复使用。' : '预设仅提供初始组合；可新建自己的组合调整类别。'}每次最多 5 条，不凑数；本机环境故障不整理。</p>
      <div className="result-category-grid">{materialCategories.map(category => { const boundary = resultCategoryBoundaries[category]; return <section key={category} className="result-category-option"><label className="check-row"><input type="checkbox" aria-label={`启用${contributionCategoryInfo[category].label}`} disabled={busy || !editing} checked={form.categories.includes(category)} onChange={event => setForm({ ...form, categories: event.target.checked ? [...form.categories, category] : form.categories.filter(item => item !== category) })}/><span><b>{contributionCategoryInfo[category].label}</b><small>{boundary.question}</small></span></label><details><summary>收录边界</summary><p>{boundary.include}</p><p className="muted small">{boundary.exclude}</p></details></section>; })}</div>
      {!!data.preferences.combinations.length && <details><summary>管理我的组合</summary>{data.preferences.combinations.map(item => { const used = Object.values(data.preferences.projects).filter(id => id === item.id).length; return <div className="row" key={item.id}><span>{item.name} · {used ? `${used} 个项目使用中` : '未使用'}</span><button className="text-button danger" disabled={busy || editing || !!used} title={used ? '请先为使用中的项目切换其他组合并保存' : '删除未使用的组合'} onClick={() => void save(item.id)}>删除</button></div>; })}</details>}
    </>}
  </div><footer><button className="primary" disabled={busy || !form || !form.name.trim() || !form.categories.length} onClick={() => void save()}>{busy ? '正在读取或保存…' : '保存并用于当前项目'}</button></footer></>;
}
