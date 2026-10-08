import React, { useEffect, useId, useState } from 'react';
import { Layers, SlidersHorizontal, X } from 'lucide-react';
import type { AgentSession, PreparationCheckpoint, PreparationScope } from '../shared/types';
import { preparationDelta } from '../shared/preparation-progress';
import { contributionCategoryInfo, type ContributionCategory } from '../shared/content';
import type { MaterialCategory, ResultCombination, ResultRulesState } from '../shared/result-rules';
import { preparationDirectionLimit, selectedPreparationDirections, type PreparationDirections } from '../shared/preparation-directions';
import { ResultRulesEditor } from './result-rules';

export function PreparationCategoryChoices({ categories, selected, directions, disabled, select, changeDirection }: {
  categories: MaterialCategory[]; selected: MaterialCategory[]; directions: PreparationDirections; disabled: boolean;
  select: (category: MaterialCategory, checked: boolean) => void;
  changeDirection: (category: MaterialCategory, value: string) => void;
}) {
  const prefix = useId();
  return <div className="preparation-category-choices">{categories.map(category => {
    const checked = selected.includes(category), label = contributionCategoryInfo[category].label, fieldId = `${prefix}-${category}`;
    return <div key={category} className={'preparation-category-choice' + (checked ? ' selected' : '')}>
      <label className="preparation-category-toggle"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => select(category, event.target.checked)}/><span>{label}</span></label>
      {checked && <div className="preparation-direction">
        <label htmlFor={fieldId}>整理方向<span>选填 · 留空使用默认提示词</span></label>
        <textarea id={fieldId} aria-label={`${label}的整理方向`} rows={3} maxLength={preparationDirectionLimit} disabled={disabled} value={directions[category] || ''} placeholder={`针对“${label}”，写下关注重点、希望保留或略过的内容。`} onChange={event => changeDirection(category, event.target.value)}/>
      </div>}
    </div>;
  })}</div>;
}

export function PreparationOptionsModal({ session, baseline, combination, initialDirections, close, started, again = false }: {
  session: AgentSession; baseline?: PreparationCheckpoint; combination?: ResultCombination; initialDirections?: PreparationDirections; again?: boolean;
  close: () => void; started: (scope: PreparationScope, categories: ContributionCategory[], temporary: boolean, directions: PreparationDirections) => Promise<void>;
}) {
  const delta = preparationDelta(session, baseline?.snapshot), canIncremental = !!baseline && delta.count > 0;
  const [scope, setScope] = useState<PreparationScope>(canIncremental ? 'incremental' : 'full');
  const [rules, setRules] = useState<ResultRulesState>(), [selected, setSelected] = useState<MaterialCategory[]>(combination?.categories || []);
  const [temporary, setTemporary] = useState<ResultCombination>();
  const [directions, setDirections] = useState<PreparationDirections>(() => ({ ...initialDirections }));
  const [configuring, setConfiguring] = useState(false), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = temporary || rules?.combination || combination;
  useEffect(() => {
    let current = true;
    setLoading(true); setTemporary(undefined);
    void window.workbench.call<ResultRulesState>('result.rules', { projectId: session.binding?.project.id }).then(value => {
      if (current) { setRules(value); setSelected(value.combination.categories); }
    }, reason => { if (current) setError(reason.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [session.id, session.binding?.project.id]);
  const disabled = busy || loading;
  return <div className="modal-backdrop"><section className={'modal preparation-dialog' + (configuring ? ' wide' : '')} role="dialog" aria-modal="true" aria-labelledby="preparation-options-title">
    <header><h2 id="preparation-options-title">{configuring ? '调整分类组合' : again ? '再次整理成果' : '整理成果'}</h2><button className="icon" aria-label={configuring ? '返回整理选项' : '关闭整理选项'} disabled={busy} onClick={() => configuring ? setConfiguring(false) : close()}><X size={18}/></button></header>
    {configuring && session.binding ? <ResultRulesEditor projectId={session.binding.project.id} projectName={session.binding.project.name} initialState={rules} temporary={temporary && { ...temporary, categories: selected }} appliedTemporary={value => { setTemporary(value); setSelected(value.categories); setConfiguring(false); }} saved={value => { setRules(value); setTemporary(undefined); setSelected(value.combination.categories); setConfiguring(false); }}/> : <>
      <div className="modal-body">
        <p className="preparation-intro">{session.title} · {session.messages.length} 条会话消息</p>
        {(baseline || again) && <fieldset className="preparation-range"><legend>整理范围</legend><div className="preparation-options">
          <label className="preparation-option"><input type="radio" name="preparation-scope" aria-label="增量整理" checked={scope === 'incremental'} disabled={disabled || !canIncremental} onChange={() => setScope('incremental')}/><span><b>只看新增内容</b><small>{canIncremental ? `增量整理 ${delta.count} 条新增或续写消息；不会重新读取完整会话。` : delta.reason}</small></span></label>
          <label className="preparation-option"><input type="radio" name="preparation-scope" aria-label="整理对话" checked={scope === 'full'} disabled={disabled} onChange={() => setScope('full')}/><span><b>整理对话</b><small>读取全部 {session.messages.length} 条消息；已有成果会作为去重参考，并说明没有新成果的原因。</small></span></label>
        </div></fieldset>}
        <section className="preparation-classification" aria-label="本次成果分类">
          <header><div><span className="preparation-section-label"><Layers size={16}/>本次成果分类</span><h3>{active?.name || '正在读取分类…'}</h3></div><button className="secondary classification-adjust" disabled={disabled || !rules} onClick={() => setConfiguring(true)}><SlidersHorizontal size={16}/>调整分类组合</button></header>
          <p>{temporary ? '临时组合仅用于本次整理，不保存为个人组合，不修改项目默认设置。' : '选择本次需要的类别。在“调整分类组合”中可新建组合，或使用不保存的临时组合。'}</p>
          <PreparationCategoryChoices categories={active?.categories || []} selected={selected} directions={directions} disabled={disabled} select={(category, checked) => setSelected(values => checked ? [...values, category] : values.filter(value => value !== category))} changeDirection={(category, value) => setDirections(values => ({ ...values, [category]: value }))}/>
          {!selected.length && !loading && <p className="inline-error" role="alert">请至少选择一个类别。</p>}
        </section>
        <p className="muted small">按实际内容整理，不凑齐分类；独立待办逐条保留。没有新成果时会说明原因，由你确认；读取失败会提示重试。</p>
        {error && <div className="inline-error" role="alert">{error}</div>}
      </div>
      <footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={disabled || !rules || !selected.length || scope === 'incremental' && !canIncremental} onClick={async () => {
        setBusy(true); setError('');
        try { await started(scope, selected, !!temporary, selectedPreparationDirections(selected, directions)); close(); } catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
      }}>{busy ? '正在创建…' : loading ? '正在读取分类…' : scope === 'incremental' ? '开始增量整理' : '开始整理对话'}</button></footer>
    </>}
  </section></div>;
}
