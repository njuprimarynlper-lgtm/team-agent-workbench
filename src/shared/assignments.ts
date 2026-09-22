import { z } from 'zod';
import type { ContributionCategory } from './content';

export const assignmentStatuses = { assigned: '待开始', in_progress: '进行中', pending_review: '待验收', completed: '已完成', cancelled: '已取消' } as const;
export type AssignmentStatus = keyof typeof assignmentStatuses;
export interface AssignmentMember { username: string; name: string }
export interface AssignmentReference { id: string; revision: number; title: string; category?: ContributionCategory; kind?: 'contribution' | 'file'; content: string; author: string; updatedAt: string }
export const assignmentUploadSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(240).regex(/^[^/\\\x00-\x1f]+$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(0).max(2 * 1024 ** 3) });
export type AssignmentUpload = z.infer<typeof assignmentUploadSchema>;
export interface AssignmentFile extends Omit<AssignmentUpload, 'id'> { id: string; md5: string; path: string; source: string }
export interface AssignmentSubmission { summary: string; references: AssignmentReference[]; files: AssignmentFile[]; submittedBy: string; submittedAt: string }
export interface AssignmentEvent { action: string; by: string; at: string; note?: string }
export interface ProjectAssignment {
  id: string; projectId: string; title: string; description: string; acceptance: string;
  assignee: string; assigneeName: string; createdBy: string; createdAt: string; updatedAt: string;
  revision: number; status: AssignmentStatus; references: AssignmentReference[]; files?: AssignmentFile[]; uploadIds?: string[]; referenceSelections?: { id: string; revision: number; attachmentHashes?: string[] }[];
  submissions?: AssignmentSubmission[]; history?: AssignmentEvent[];
  deletedAt?: string; deletedBy?: string; purgedAt?: string;
}
export type AssignmentView = 'mine' | 'sent' | 'team';
export function assignmentViewItems(items: ProjectAssignment[], username: string, admin: boolean, view: AssignmentView) {
  return items.filter(task => !admin || view === 'mine' ? task.assignee === username : view === 'sent' ? task.createdBy === username : true);
}
export const assignmentCreateSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(12000),
  acceptance: z.string().trim().max(6000).default(''), assignee: z.string().min(1).max(160),
  references: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive(), attachmentHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(30).optional() })).max(20),
  // Optional to retain compatibility with already-created and older tasks.
  uploadIds: z.array(z.string().uuid()).max(30).refine(values => new Set(values).size === values.length, '任务附件不能重复选择').optional()
}).refine(value => new Set(value.references.map(item => item.id)).size === value.references.length, '关联结论不能重复');
export type AssignmentCreate = z.infer<typeof assignmentCreateSchema>;
export const assignmentSubmissionSchema = z.object({
  summary: z.string().trim().min(1, '请填写结果说明').max(6000),
  references: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() })).max(20).default([]).refine(values => new Set(values.map(item => item.id)).size === values.length, '关联成果不能重复'),
  uploadIds: z.array(z.string().uuid()).max(30).default([]).refine(values => new Set(values).size === values.length, '附件不能重复')
});
export const assignmentStatusSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive(), status: z.enum(['in_progress', 'pending_review', 'completed', 'cancelled', 'deleted', 'restored', 'purged']), reason: z.string().trim().max(6000).optional(), submission: assignmentSubmissionSchema.optional(), selectionId: z.string().uuid().optional() });
export type AssignmentStatusChange = z.infer<typeof assignmentStatusSchema>;

export const assignmentEventLabels: Record<string, string> = { in_progress: '开始工作', pending_review: '提交验收', completed: '确认完成', rejected: '退回继续工作', cancelled: '取消任务', deleted: '删除任务', restored: '恢复任务' };
export function assignmentAllFiles(task: ProjectAssignment) { return [...(task.files || []), ...(task.submissions || []).flatMap(item => item.files)]; }
export function assignmentInScope(task: ProjectAssignment, scope: 'active' | 'all' | 'deleted') {
  return !task.purgedAt && (scope === 'deleted' ? !!task.deletedAt : !task.deletedAt && (scope === 'all' || ['assigned', 'in_progress', 'pending_review'].includes(task.status)));
}

// The server mirrors this transition table. Never infer completion from a Session or model event.
export function transitionAssignment(task: ProjectAssignment, raw: AssignmentStatusChange, actor: { username: string; admin: boolean }, at: string): ProjectAssignment {
  const input = assignmentStatusSchema.parse(raw), status = input.status;
  if (task.purgedAt || !actor.admin && task.assignee !== actor.username) throw new Error('任务不存在或无权访问');
  if (task.revision !== input.revision) throw new Error('任务状态已更新，请刷新后重试');
  const next = structuredClone(task), terminal = ['completed', 'cancelled'].includes(task.status);
  const requireAdmin = () => { if (!actor.admin) throw new Error('只有本组组管理员可以执行此操作'); };
  const requireAssignee = () => { if (task.assignee !== actor.username) throw new Error('只有负责人可以提交任务结果或开始工作'); };
  const invalid = () => { throw new Error('当前任务状态不允许此操作'); };
  let action: string = status;
  if (input.submission && !(status === 'pending_review' || status === 'completed' && task.status === 'in_progress')) throw new Error('当前操作不能修改已提交的验收结果');
  if (['deleted', 'restored', 'purged'].includes(status)) {
    requireAdmin();
    if (!terminal || (status === 'deleted' ? !!task.deletedAt : !task.deletedAt)) invalid();
    if (status === 'deleted') { next.deletedAt = at; next.deletedBy = actor.username; }
    else if (status === 'restored') { delete next.deletedAt; delete next.deletedBy; }
    else { next.purgedAt = at; next.title = ''; next.description = ''; next.acceptance = ''; next.references = []; next.files = []; next.submissions = []; next.history = []; delete next.referenceSelections; delete next.uploadIds; }
  } else {
    if (task.deletedAt || terminal) invalid();
    if (status === 'cancelled') { requireAdmin(); if (!input.reason) throw new Error('请填写取消原因'); }
    else if (status === 'pending_review') { requireAssignee(); if (task.status !== 'in_progress' || !input.submission) invalid(); }
    else if (status === 'completed') {
      requireAdmin();
      if (!(task.status === 'pending_review' || task.status === 'in_progress' && task.assignee === actor.username && task.createdBy === actor.username && input.submission)) invalid();
    } else if (task.status === 'pending_review') {
      requireAdmin(); if (!input.reason) throw new Error('请填写退回原因'); action = 'rejected';
    } else { requireAssignee(); if (task.status === 'in_progress') return next; }
    next.status = status as AssignmentStatus;
  }
  next.revision++; next.updatedAt = at;
  if (status !== 'purged') (next.history ||= []).push({ action, by: actor.username, at, ...(input.reason ? { note: input.reason } : {}) });
  return next;
}

export function assignmentMarkdown(task: ProjectAssignment) {
  return `# ${task.title}\n\n派发人：${task.createdBy}\n负责人：${task.assigneeName}（${task.assignee}）\n派发时间：${task.createdAt}\n\n## 任务目标与工作范围\n${task.description}\n\n## 验收要求\n${task.acceptance || '尚未填写，请与派发人确认。'}`;
}
