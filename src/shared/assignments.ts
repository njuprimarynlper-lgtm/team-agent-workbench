import { z } from 'zod';

export const assignmentStatuses = { assigned: '待开始', in_progress: '进行中', completed: '已完成', cancelled: '已取消' } as const;
export type AssignmentStatus = keyof typeof assignmentStatuses;
export interface AssignmentMember { username: string; name: string }
export interface AssignmentReference { id: string; revision: number; title: string; content: string; author: string; updatedAt: string }
export interface ProjectAssignment {
  id: string; projectId: string; title: string; description: string; acceptance: string;
  assignee: string; assigneeName: string; createdBy: string; createdAt: string; updatedAt: string;
  revision: number; status: AssignmentStatus; references: AssignmentReference[];
}
export const assignmentCreateSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(12000),
  acceptance: z.string().trim().max(6000).default(''), assignee: z.string().min(1).max(160),
  references: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() })).max(20)
}).refine(value => new Set(value.references.map(item => item.id)).size === value.references.length, '关联结论不能重复');
export type AssignmentCreate = z.infer<typeof assignmentCreateSchema>;
export const assignmentStatusSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive(), status: z.enum(['in_progress', 'completed', 'cancelled']) });
export type AssignmentStatusChange = z.infer<typeof assignmentStatusSchema>;

export function assignmentMarkdown(task: ProjectAssignment) {
  return `# ${task.title}\n\n派发人：${task.createdBy}\n负责人：${task.assigneeName}（${task.assignee}）\n派发时间：${task.createdAt}\n\n## 任务目标与工作范围\n${task.description}\n\n## 验收要求\n${task.acceptance || '尚未填写，请与派发人确认。'}`;
}
