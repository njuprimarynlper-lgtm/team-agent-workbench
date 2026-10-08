import { z } from 'zod';
import type { Project, RemoteBinding } from './types';

const label = z.string().min(1).max(200).regex(/^[^\x00-\x1f]+$/);
export const submissionSourceSchema = z.object({
  kind: z.enum(['session', 'personal_result', 'team_result', 'manual', 'file', 'unknown']),
  id: label.optional(), title: z.string().min(1).max(240).regex(/^[^\x00-\x1f]+$/).optional(), version: z.number().int().positive().optional(),
  projectId: label.optional(), capturedAt: z.string().max(64).optional(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), author: label.optional()
});
export const submissionDestinationSchema = z.object({ projectId: label, projectName: label, groupName: label.optional(), groupLabel: label.optional() });
export const submissionRecordSchema = z.object({ version: z.literal(1), submittedBy: label, submittedAt: z.string().max(64), destination: submissionDestinationSchema, sources: z.array(submissionSourceSchema).min(1).max(30) });
export type SubmissionSource = z.infer<typeof submissionSourceSchema>;
export type SubmissionDestination = z.infer<typeof submissionDestinationSchema>;
export type SubmissionRecord = z.infer<typeof submissionRecordSchema>;

export function submissionDestination(project: Project): SubmissionDestination {
  return { projectId: project.id, projectName: project.name, ...(project.groupName ? { groupName: project.groupName } : {}), ...(project.groupLabel ? { groupLabel: project.groupLabel } : {}) };
}
export function submissionRecord(binding: RemoteBinding, sources: SubmissionSource[], at = new Date().toISOString()): SubmissionRecord {
  return submissionRecordSchema.parse({ version: 1, submittedBy: binding.username, submittedAt: at, destination: submissionDestination(binding.project), sources: sources.length ? sources : [{ kind: 'unknown' }] });
}
// Server-side actor/destination are authoritative; client display names never decide access.
export function acceptedSubmission(record: SubmissionRecord | undefined, binding: RemoteBinding, actor: string, destination = submissionDestination(binding.project), sources?: SubmissionSource[]): SubmissionRecord {
  if (record && (record.submittedBy !== actor || record.destination.projectId !== destination.projectId || record.destination.groupName !== destination.groupName)) throw new Error('提交账号或目标与当前授权项目不一致');
  if (record?.sources.some(source => source.projectId && source.projectId !== destination.projectId)) throw new Error('提交来源不属于当前项目');
  return submissionRecordSchema.parse({ version: 1, submittedBy: actor, submittedAt: new Date().toISOString(), destination, sources: sources || record?.sources || [{ kind: 'unknown' }] });
}
export function destinationLabel(project: Project, projects: Project[] = []): string {
  const ambiguous = projects.some(other => other.name === project.name && (other.id !== project.id || other.groupName !== project.groupName));
  const group = project.groupLabel || project.groupName;
  return ambiguous && group ? `${group} / ${project.name}` : project.name;
}
export function fullDestination(destination: SubmissionDestination): string {
  return [destination.groupLabel || destination.groupName, destination.projectName].filter(Boolean).join(' / ');
}
export function sourceLabel(source: SubmissionSource): string {
  const name = source.title ? `“${source.title}”` : '';
  switch (source.kind) {
    case 'session': return `会话${name}${source.capturedAt || source.snapshotHash ? ' · 整理时的对话快照' : ''}`;
    case 'personal_result': return `个人成果${name}${source.version ? ` · v${source.version}` : ''}`;
    case 'team_result': return `团队成果${name}${source.version ? ` · v${source.version}` : ''}${source.author ? ` · ${source.author}` : ''}`;
    case 'file': return `文件${name}`;
    case 'manual': return '手动编写';
    default: return '未记录来源';
  }
}
export function activityActor(item: { change: string; updatedBy?: string; author?: string }): string {
  return item.updatedBy || (item.change === 'new' ? item.author : undefined) || '';
}
export function activityText(item: { change: string; updatedBy?: string; author?: string; title: string }, title = item.title): string {
  const verb: Record<string, string> = { new: '提交了', updated: '更新了', deleted: '移除了', merged: '整理了', superseded: '替代了' };
  const actor = activityActor(item);
  return `${actor ? actor + ' ' : ''}${verb[item.change] || '更新了'}《${title}》`;
}
