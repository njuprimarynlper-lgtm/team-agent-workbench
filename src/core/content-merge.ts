import { z } from 'zod';
import type { ContentMergeAnalysis, Draft } from '../shared/types';

const positionSchema = z.object({
  sourceIds: z.array(z.string().uuid()).min(1).max(20),
  statement: z.string().trim().min(1).max(200000)
});

const resultSchema = z.object({
  title: z.string().trim().min(1).max(200),
  overview: z.string().trim().min(1).max(200000),
  consensus: z.array(z.string().trim().min(1).max(200000)).max(100).default([]),
  conflicts: z.array(z.object({
    topic: z.string().trim().min(1).max(500),
    positions: z.array(positionSchema).min(2).max(20),
    resolution: z.string().trim().max(200000).optional(),
    requiresDecision: z.boolean().default(true)
  })).max(100).default([]),
  evidence: z.array(z.object({
    claim: z.string().trim().min(1).max(200000),
    sourceIds: z.array(z.string().uuid()).min(1).max(20)
  })).max(200).default([]),
  scope: z.string().trim().max(200000).optional(),
  unresolved: z.array(z.string().trim().min(1).max(200000)).max(100).default([])
});

export function applyContentMerge(draft: Draft, answer: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    throw new Error('AI 返回的融合结果格式不完整，请重试。来源条目未发生任何变化。');
  }
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) throw new Error('AI 返回的融合结果缺少标题、综合结论或有效的冲突结构，请重试。来源条目未发生任何变化。');
  const allowed = new Set((draft.mergeSources || []).map(item => item.id));
  const referenced = [
    ...parsed.data.evidence.flatMap(item => item.sourceIds),
    ...parsed.data.conflicts.flatMap(item => item.positions.flatMap(position => position.sourceIds))
  ];
  if (referenced.some(id => !allowed.has(id))) throw new Error('AI 引用了未选择的来源，已拒绝该结果，请重试。');

  const analysis: ContentMergeAnalysis = parsed.data;
  const names = new Map((draft.mergeSources || []).map(item => [item.id, `${item.title}（${item.author} · v${item.revision}）`]));
  const refs = (ids: string[]) => [...new Set(ids)].map(id => names.get(id)).filter(Boolean).join('；');
  const sections = [
    `## 综合结论\n\n${analysis.overview}`,
    analysis.consensus.length ? `## 已确认的共识\n\n${analysis.consensus.map(item => `- ${item}`).join('\n')}` : '',
    analysis.conflicts.length ? `## 差异与冲突\n\n${analysis.conflicts.map(item => `### ${item.topic}\n\n${item.positions.map(position => `- ${position.statement}\n  - 来源：${refs(position.sourceIds)}`).join('\n')}${item.resolution ? `\n\n建议处理：${item.resolution}` : ''}\n\n${item.requiresDecision ? '> 此项仍需子管理员确认，AI 未擅自裁决。' : '> 已有材料支持上述处理。'}`).join('\n\n')}` : '',
    analysis.evidence.length ? `## 证据与来源\n\n${analysis.evidence.map(item => `- ${item.claim}\n  - 来源：${refs(item.sourceIds)}`).join('\n')}` : '',
    analysis.scope ? `## 适用范围\n\n${analysis.scope}` : '',
    analysis.unresolved.length ? `## 未解决问题\n\n${analysis.unresolved.map(item => `- ${item}`).join('\n')}` : '',
    `## 来源记录\n\n${(draft.mergeSources || []).map(item => `- ${names.get(item.id)} · ${item.updatedAt} · ID ${item.id}`).join('\n')}`
  ].filter(Boolean);
  draft.title = parsed.data.title;
  draft.body = sections.join('\n\n');
  draft.generatedBody = draft.body;
  draft.mergeAnalysis = analysis;
}
