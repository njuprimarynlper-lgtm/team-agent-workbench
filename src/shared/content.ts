import { z } from 'zod';
export const gitRevisionSchema = z.object({ commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), branch: z.string().max(256), dirty: z.boolean(), capturedAt: z.string() });
export type GitRevision = z.infer<typeof gitRevisionSchema>;
export const contributionCategories = ['experiment_result', 'failed_direction', 'finding', 'issue', 'baseline_change_proposal'] as const;
export const contributionCategorySchema = z.enum(contributionCategories);
export type ContributionCategory = z.infer<typeof contributionCategorySchema>;
export const contributionCategoryInfo: Record<ContributionCategory, { label: string; folder: string; description: string }> = {
  experiment_result: { label: '实验结果', folder: 'experiments', description: '有目标、对照与可验证结果的实验。' },
  failed_direction: { label: '未奏效方向', folder: 'failed-directions', description: '有证据表明未奏效、值得避免重复的尝试。' },
  finding: { label: '结论与发现', folder: 'findings', description: '可复用的方向性或结果性结论。' },
  issue: { label: '问题与风险', folder: 'issues', description: '需要跟进的问题、风险与触发条件。' },
  baseline_change_proposal: { label: '项目基线变更建议', folder: 'baseline-change-proposals', description: '需要组管理员决定的目标、约束或规则变更。' }
};
const titlePrefix = /^【[^】]{1,24}】\s*/u;
export function resultTitle(section: string, title: string, max = 120) {
  const prefix = `【${section}】`, subject = title.trim().replace(titlePrefix, '').trim() || '未命名成果';
  return `${prefix} ${subject.slice(0, Math.max(1, max - prefix.length - 1))}`;
}
export function contributionTitle(category: ContributionCategory, title: string) { return resultTitle(contributionCategoryInfo[category].label, title); }
export function titleSubject(title: string) { return title.replace(titlePrefix, '').trim(); }
export function contentAliasKey(projectId: string, contentId: string) { return `${projectId}:${contentId}`; }
export const contributionCategoryFields: Record<ContributionCategory, readonly string[]> = {
  experiment_result: ['objective', 'change', 'environment', 'baseline', 'result', 'evidence', 'scope', 'limitations', 'nextSteps'],
  failed_direction: ['objective', 'approach', 'failure', 'evidence', 'likelyCause', 'avoidWhen', 'reusableInsight'],
  finding: ['statement', 'evidence', 'scope', 'uncertainty', 'nextSteps'],
  issue: ['problem', 'trigger', 'impact', 'evidence', 'reproduction', 'workaround', 'nextAction'],
  baseline_change_proposal: ['baselineItem', 'currentValue', 'proposedValue', 'rationale', 'evidence', 'impact', 'validationNeeded']
};
export const contentMetadataSchema = z.object({ title: z.string().max(200).default(''), description: z.string().max(2 * 1024 * 1024).default(''), repoUrl: z.string().max(2048).optional(), git: gitRevisionSchema.optional(), kind: z.enum(['contribution', 'file', 'trajectory']).default('file'), category: contributionCategorySchema.optional(), fields: z.record(z.string(), z.string().max(200000)).optional(), sourceSessionId: z.string().optional(), sourceSessionTitle: z.string().max(120).optional(), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/).optional() });
export type ContentMetadata = z.infer<typeof contentMetadataSchema>;
export interface ContentProvenance { id: string; revision: number; title: string; author: string; updatedAt: string }
export interface SharedContent extends ContentMetadata { id: string; path: string; author: string; revision: number; state: 'submitted' | 'curated'; createdAt: string; updatedAt: string; updatedBy: string; sha256: string; size: number; sources?: string[]; provenance?: ContentProvenance[]; }
export const contentEditSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive(), action: z.enum(['save', 'delete']), title: z.string().trim().min(1).max(200).optional(), description: z.string().max(2 * 1024 * 1024).optional(), repoUrl: z.string().max(2048).optional(), sourceSessionTitle: z.string().trim().min(1).max(120).optional(), curate: z.boolean().default(false), merge: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() })).max(100).default([]) });
export type ContentEdit = z.infer<typeof contentEditSchema>;
