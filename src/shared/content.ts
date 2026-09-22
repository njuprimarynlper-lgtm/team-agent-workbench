import { z } from 'zod';
export const gitRevisionSchema = z.object({ commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), branch: z.string().max(256), dirty: z.boolean(), capturedAt: z.string() });
export type GitRevision = z.infer<typeof gitRevisionSchema>;
export const materialCategories = ['finding', 'project_standard', 'requirement', 'design', 'method_exploration', 'verification', 'issue', 'troubleshooting', 'guide', 'research', 'comparison', 'baseline_change_proposal'] as const;
export const contributionCategories = ['experiment_result', 'failed_direction', ...materialCategories] as const;
export const contributionCategorySchema = z.enum(contributionCategories);
export type ContributionCategory = z.infer<typeof contributionCategorySchema>;
export const contributionCategoryInfo: Record<ContributionCategory, { label: string; folder: string; description: string }> = {
  experiment_result: { label: '项目结论', folder: 'experiments', description: '有验证依据的实验结论（兼容已有成果）。' },
  failed_direction: { label: '项目结论', folder: 'failed-directions', description: '有证据证明未奏效的方向（兼容已有成果）。' },
  finding: { label: '项目结论', folder: 'findings', description: '有事实或验证支持的可复用结论，也包括有证据的失败经验。' },
  project_standard: { label: '项目标准', folder: 'project-standards', description: '人明确确认的要求、验收口径或规则；AI 建议不能成为标准。' },
  method_exploration: { label: '方法探索', folder: 'method-explorations', description: '值得继续验证的方法或思路，必须保留未验证状态。' },
  issue: { label: '问题与风险', folder: 'issues', description: '需要跟进的问题、风险与触发条件。' },
  baseline_change_proposal: { label: '改进建议', folder: 'baseline-change-proposals', description: '有明确对象和理由、尚未采纳的改进建议。' },
  requirement: { label: '需求说明', folder: 'requirements', description: '用户或业务需要什么能力，以及范围与非目标；不写实现方法或强制规范。' },
  design: { label: '设计方案', folder: 'designs', description: '为具体需求给出的可实施方案、结构和关键取舍；不是仅待验证的假设。' },
  verification: { label: '验证结果', folder: 'verifications', description: '一次明确验证的对象、观察结果和覆盖边界；不推广为通用判断。' },
  troubleshooting: { label: '排障经验', folder: 'troubleshooting', description: '项目本身缺陷的已确认原因和经验证有效的修复；排除本机环境故障。' },
  guide: { label: '操作指南', folder: 'guides', description: '可重复执行的项目业务或交付操作、必要前提及检查点；排除本机安装和配置修复。' },
  research: { label: '调研发现', folder: 'research', description: '从可追溯资料获得的外部事实及适用范围；不是自己的实验结果或未经论证的决策。' },
  comparison: { label: '方案对比', folder: 'comparisons', description: '至少两个可选方案在同一目标、同一维度下的差异和取舍；不逐项抄资料。' }
};
const titlePrefix = /^【[^】]{1,24}】\s*/u;
export function resultTitle(section: string, title: string, max = 120) {
  const prefix = `【${section}】`, subject = title.trim().replace(titlePrefix, '').trim() || '未命名成果';
  return `${prefix} ${subject.slice(0, Math.max(1, max - prefix.length - 1))}`;
}
export function contributionTitle(category: ContributionCategory, title: string) { return resultTitle(contributionCategoryInfo[category].label, title); }
export function titleSubject(title: string) { return title.replace(titlePrefix, '').trim(); }
export function projectResultLabel(item: { title: string; category?: ContributionCategory; provenance?: unknown[] }) {
  if (item.category) return contributionCategoryInfo[item.category].label;
  if (item.provenance?.length) return '项目结论';
  const label = item.title.match(/^【([^】]+)】/u)?.[1];
  return label && Object.values(contributionCategoryInfo).some(info => info.label === label) ? label : '项目成果';
}
export function projectResultTitle(item: { title: string; category?: ContributionCategory; provenance?: unknown[] }, alias?: string) { return resultTitle(projectResultLabel(item), alias || item.title, 200); }
export function contentAliasKey(projectId: string, contentId: string) { return `${projectId}:${contentId}`; }
export const contributionCategoryFields: Record<ContributionCategory, readonly string[]> = {
  experiment_result: ['objective', 'change', 'environment', 'baseline', 'result', 'evidence', 'scope', 'limitations', 'nextSteps'],
  failed_direction: ['objective', 'approach', 'failure', 'evidence', 'likelyCause', 'avoidWhen', 'reusableInsight'],
  finding: ['statement', 'evidence', 'scope', 'uncertainty', 'nextSteps'],
  project_standard: ['statement', 'evidence', 'scope'],
  method_exploration: ['approach', 'uncertainty', 'nextSteps'],
  issue: ['problem', 'trigger', 'impact', 'evidence', 'reproduction', 'workaround', 'nextAction'],
  baseline_change_proposal: ['baselineItem', 'currentValue', 'proposedValue', 'rationale', 'evidence', 'impact', 'validationNeeded'],
  requirement: ['statement', 'scope', 'evidence'], design: ['approach', 'rationale', 'limitations'],
  verification: ['result', 'evidence', 'limitations'], troubleshooting: ['problem', 'likelyCause', 'workaround'],
  guide: ['scope', 'approach', 'result'], research: ['statement', 'evidence', 'scope'], comparison: ['approach', 'evidence', 'limitations']
};
export const contentAttachmentSchema = z.object({ name: z.string().min(1).max(240).regex(/^[^/\\\x00-\x1f]+$/), path: z.string().max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(0).max(2 * 1024 ** 3) });
export type ContentAttachment = z.infer<typeof contentAttachmentSchema>;
export const contentMetadataSchema = z.object({ title: z.string().max(200).default(''), description: z.string().max(2 * 1024 * 1024).default(''), repoUrl: z.string().max(2048).optional(), git: gitRevisionSchema.optional(), kind: z.enum(['contribution', 'file', 'trajectory']).default('file'), category: contributionCategorySchema.optional(), fields: z.record(z.string(), z.string().max(200000)).optional(), sourceSessionId: z.string().optional(), sourceSessionTitle: z.string().max(120).optional(), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), attachments: z.array(contentAttachmentSchema).max(30).optional(), sourceDetails: z.string().max(8000).optional() });
export type ContentMetadata = z.infer<typeof contentMetadataSchema>;
export interface ContentProvenance { id: string; revision: number; title: string; author: string; updatedAt: string }
export interface SharedContent extends ContentMetadata { id: string; path: string; author: string; revision: number; state: 'submitted' | 'curated'; createdAt: string; updatedAt: string; updatedBy: string; sha256: string; size: number; sources?: string[]; provenance?: ContentProvenance[]; }
export function canDeleteSharedContent(item: Pick<SharedContent, 'author' | 'state'>, username: string, admin: boolean) {
  return admin || item.author === username && item.state === 'submitted';
}
export const contentDeleteSelectionsSchema = z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() })).min(1).max(100).refine(items => new Set(items.map(item => item.id)).size === items.length, '不能重复选择同一成果');
export type ContentDeleteSelection = z.infer<typeof contentDeleteSelectionsSchema>[number];
export interface ContentDeleteResult { deletedIds: string[]; remaining: ContentDeleteSelection[]; error?: string; uncertainId?: string }
export const contentEditSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive(), action: z.enum(['save', 'delete']), title: z.string().trim().min(1).max(200).optional(), description: z.string().max(2 * 1024 * 1024).optional(), category: contributionCategorySchema.optional(), sourceDetails: z.string().max(8000).optional(), repoUrl: z.string().max(2048).optional(), sourceSessionTitle: z.string().trim().min(1).max(120).optional(), curate: z.boolean().default(false), merge: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() })).max(100).default([]) });
export type ContentEdit = z.infer<typeof contentEditSchema>;
