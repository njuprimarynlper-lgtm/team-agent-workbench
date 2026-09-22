import React from 'react';
import { Check, FileCheck2 } from 'lucide-react';
import type { Draft } from '../shared/types';
import { contributionCategoryInfo } from '../shared/content';
import { emptyPreparationResult } from '../shared/preparation-review';

export function EmptyPreparationReview({ draft, busy, confirm, viewConclusion }: { draft: Draft; busy: boolean; confirm: () => void; viewConclusion: (projectId: string, id: string) => void }) {
  const result = emptyPreparationResult(draft);
  return <section className="empty-preparation-review" aria-label="空整理结果确认">
    <div className="empty-preparation-heading"><FileCheck2 size={26}/><div><h2>{result.confirmedAt ? '已确认本次无需保留' : '本次未生成新成果，请核对'}</h2><p>{draft.snapshot ? `${draft.preparationScope === 'incremental' ? '增量整理' : '全量整理'} · 本次 ${draft.snapshot.messageCount} 条消息 / 会话共 ${draft.snapshot.totalMessageCount ?? draft.snapshot.messageCount} 条` : draft.mergeSources?.length ? `处理 ${draft.mergeSources.length} 条已有成果` : '旧记录未保存整理范围'}</p></div></div>
    <p className="empty-preparation-reason">{result.explanation}</p>
    {!!result.existingResults?.length && <div className="empty-preparation-matches"><b>对应的已有成果</b>{result.existingResults.map(item => <button className="text-button" key={item.id} onClick={() => draft.binding && viewConclusion(draft.binding.project.id, item.id)} disabled={!draft.binding}>{item.title}</button>)}</div>}
    {!!draft.resultRules?.categories.length && <p className="muted small">本次分类：{draft.resultRules.categories.map(category => contributionCategoryInfo[category].label).join('、')}</p>}
    {result.confirmedAt ? <p className="empty-preparation-confirmed"><Check size={16}/>已确认 · {new Date(result.confirmedAt).toLocaleString()}</p> : <div className="empty-preparation-footer"><p>确认后记录本次结果，不创建或上传空成果。若有遗漏，可通过“再次整理”调整范围和分类。</p><button className="primary" disabled={busy} onClick={confirm}><Check size={16}/>{busy ? '正在保存…' : '确认本次无需保留'}</button></div>}
  </section>;
}
