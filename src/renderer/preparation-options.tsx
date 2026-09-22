import React, { useEffect, useState } from 'react';
import { Layers, SlidersHorizontal, X } from 'lucide-react';
import type { AgentSession, PreparationCheckpoint, PreparationScope } from '../shared/types';
import { preparationDelta } from '../shared/preparation-progress';
import { contributionCategoryInfo, type ContributionCategory } from '../shared/content';
import type { ResultCombination, ResultRulesState } from '../shared/result-rules';
import { ResultRulesEditor } from './result-rules';

export function PreparationOptionsModal({ session, baseline, combination, close, started, again = false }: {
  session: AgentSession; baseline?: PreparationCheckpoint; combination?: ResultCombination; again?: boolean;
  close: () => void; started: (scope: PreparationScope, categories: ContributionCategory[]) => Promise<void>;
}) {
  const delta = preparationDelta(session, baseline?.snapshot), canIncremental = !!baseline && delta.count > 0;
  const [scope, setScope] = useState<PreparationScope>(canIncremental ? 'incremental' : 'full');
  const [rules, setRules] = useState<ResultRulesState>(), [selected, setSelected] = useState<ContributionCategory[]>(combination?.categories || []);
  const [configuring, setConfiguring] = useState(false), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = rules?.combination || combination;
  useEffect(() => {
    let current = true;
    setLoading(true);
    void window.workbench.call<ResultRulesState>('result.rules', { projectId: session.binding?.project.id }).then(value => {
      if (current) { setRules(value); setSelected(value.combination.categories); }
    }, reason => { if (current) setError(reason.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [session.binding?.project.id]);
  const disabled = busy || loading;
  return <div className="modal-backdrop"><section className={'modal preparation-dialog' + (configuring ? ' wide' : '')} role="dialog" aria-modal="true" aria-labelledby="preparation-options-title">
    <header><h2 id="preparation-options-title">{configuring ? '调整我的分类' : again ? '再次整理成果' : '整理成果'}</h2><button className="icon" aria-label={configuring ? '返回整理选项' : '关闭整理选项'} disabled={busy} onClick={() => configuring ? setConfiguring(false) : close()}><X size={18}/></button></header>
    {configuring && session.binding ? <ResultRulesEditor projectId={session.binding.project.id} projectName={session.binding.project.name} initialState={rules} saved={value => { setRules(value); setSelected(value.combination.categories); setConfiguring(false); }}/> : <>
      <div className="modal-body">
        <p className="preparation-intro">{session.title} · {session.messages.length} 条会话消息</p>
        {(baseline || again) && <fieldset className="preparation-range"><legend>整理范围</legend><div className="preparation-options">
          <label className="preparation-option"><input type="radio" name="preparation-scope" aria-label="增量整理" checked={scope === 'incremental'} disabled={disabled || !canIncremental} onChange={() => setScope('incremental')}/><span><b>只看新增内容</b><small>{canIncremental ? `增量整理 ${delta.count} 条新增或续写消息；不会重新读取完整会话。` : delta.reason}</small></span></label>
          <label className="preparation-option"><input type="radio" name="preparation-scope" aria-label="全量整理" checked={scope === 'full'} disabled={disabled} onChange={() => setScope('full')}/><span><b>重新整理整个会话</b><small>读取全部 {session.messages.length} 条消息；已有成果会作为去重参考，并说明没有新成果的原因。</small></span></label>
        </div></fieldset>}
        <section className="preparation-classification" aria-label="本次成果分类">
          <header><div><span className="preparation-section-label"><Layers size={16}/>本次成果分类</span><h3>{active?.name || '正在读取分类…'}</h3></div><button className="secondary classification-adjust" disabled={disabled || !rules} onClick={() => setConfiguring(true)}><SlidersHorizontal size={16}/>调整我的分类</button></header>
          <p>选择本次需要的类别。调整分类组合可添加其他类别，并用于后续整理。</p>
          <div className="preparation-category-choices">{active?.categories.map(category => <label key={category} className={'preparation-category-choice' + (selected.includes(category) ? ' selected' : '')}><input type="checkbox" checked={selected.includes(category)} disabled={disabled} onChange={event => setSelected(values => event.target.checked ? [...values, category] : values.filter(value => value !== category))}/>{contributionCategoryInfo[category].label}</label>)}</div>
          {!selected.length && !loading && <p className="inline-error" role="alert">请至少选择一个类别。</p>}
        </section>
        <p className="muted small">最多提炼 5 条，不按类别凑数。没有新成果时会说明原因，由你确认；读取失败会提示重试。</p>
        {error && <div className="inline-error" role="alert">{error}</div>}
      </div>
      <footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={disabled || !rules || !selected.length || scope === 'incremental' && !canIncremental} onClick={async () => {
        setBusy(true); setError('');
        try { await started(scope, selected); close(); } catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
      }}>{busy ? '正在创建…' : loading ? '正在读取分类…' : `开始${scope === 'incremental' ? '增量' : '全量'}整理`}</button></footer>
    </>}
  </section></div>;
}
