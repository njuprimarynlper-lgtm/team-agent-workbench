import type { ResultStatus } from './result-status';
export { resultStatusSchema, type ResultStatus } from './result-status';
import { contributionCategoryInfo, type ContributionCategory } from './content';

export const resultCategories = ['project_goal', 'project_material', 'capability', 'exploration', 'todo'] as const;
export type ResultCategory = typeof resultCategories[number];
export const legacyResultCategories: Record<string, ResultCategory> = {
  project_standard: 'project_goal', requirement: 'project_goal', research: 'project_material', issue: 'todo', baseline_change_proposal: 'todo',
  finding: 'exploration', experiment_result: 'exploration', failed_direction: 'exploration', design: 'exploration',
  method_exploration: 'exploration', verification: 'exploration', troubleshooting: 'exploration', guide: 'exploration', comparison: 'exploration'
};
const legacyLabels: Record<string, ResultCategory> = {
  项目标准: 'project_goal', 需求说明: 'project_goal', 调研发现: 'project_material', 问题与风险: 'todo', 改进建议: 'todo',
  项目经验: 'exploration', 项目结论: 'exploration', 结论与发现: 'exploration', 方法探索: 'exploration',
  设计方案: 'exploration', 验证结果: 'exploration', 排障经验: 'exploration', 操作指南: 'exploration', 方案对比: 'exploration', 综合整理: 'exploration'
};
export function canonicalCategory(category?: string): ResultCategory | undefined {
  return resultCategories.includes(category as ResultCategory) ? category as ResultCategory : legacyResultCategories[category || ''];
}
export function resultCategory(item: { category?: string; title: string; kind?: string }): ResultCategory | undefined {
  if (item.kind && item.kind !== 'contribution') return undefined;
  if (item.category) return canonicalCategory(item.category);
  const label = item.title.match(/^【([^】]+)】/)?.[1];
  return resultCategories.find(category => contributionCategoryInfo[category].label === label) || legacyLabels[label || ''] || 'exploration';
}
export const resultStatusLabels: Record<ResultStatus, string> = { pending: '待处理', confirmed: '已确认', available: '可使用', limited: '有限可用', in_progress: '进行中', pending_review: '待验收', completed: '已完成', cancelled: '已取消' };
export const categoryStatuses: Record<ResultCategory, ResultStatus[]> = { project_goal: ['pending', 'confirmed'], project_material: [], capability: ['available', 'limited'], exploration: [], todo: ['pending', 'in_progress', 'completed', 'cancelled'] };
export const resultDefaultStatus = (category?: string): ResultStatus | undefined => ({ project_goal: 'pending', capability: 'limited', todo: 'pending' } as const)[canonicalCategory(category) as 'project_goal' | 'capability' | 'todo'];
type ResultState = { title: string; category?: string; resultStatus?: ResultStatus; linkedAssignments?: { status: string }[] };
export function effectiveResultStatus(item: ResultState): ResultStatus | undefined {
  const category = resultCategory(item), tasks = item.linkedAssignments;
  if (category === 'todo' && tasks?.length) {
    const states = tasks.map(task => task.status);
    if (states.some(status => !['assigned', 'in_progress', 'pending_review', 'completed', 'cancelled'].includes(status))) return undefined;
    if (states.every(status => ['completed', 'cancelled'].includes(status))) return states.includes('completed') ? 'completed' : 'cancelled';
    if (states.includes('in_progress')) return 'in_progress';
    if (states.includes('assigned')) return 'pending';
    return 'pending_review';
  }
  return item.resultStatus || resultDefaultStatus(category);
}
export const resultStateLabel = (item: ResultState) => {
  const category = resultCategory(item), status = effectiveResultStatus(item);
  if (category === 'todo' && item.linkedAssignments?.length && !status) return '跟随项目任务';
  return category === 'project_goal' && status === 'pending' ? '待确认' : status ? resultStatusLabels[status] : '';
};
export function validateResultStatus(category: ContributionCategory | undefined, status?: ResultStatus) {
  if (status && (!canonicalCategory(category) || !categoryStatuses[canonicalCategory(category)!].includes(status))) throw new Error('所选状态不适用于这个分类');
}
export function sameResultCategory(items: { category?: string; title: string; kind?: string }[], target?: string): ResultCategory {
  const categories = new Set(items.map(resultCategory));
  if (!items.length || categories.size !== 1 || categories.has(undefined)) throw new Error('只能合并同一分类的文字成果，请先修改分类或分别整理');
  const category = [...categories][0]!;
  if (target && canonicalCategory(target) !== category) throw new Error('合并结果必须保留来源分类；请先分别修改来源分类');
  return category;
}
export function assertTodoMerge(items: { category?: string; title: string; kind?: string }[], confirmed = false) {
  if (items.length > 1 && sameResultCategory(items) === 'todo' && !confirmed) throw new Error('请确认这些待办是同一事项的重复记录；独立事项请分别保留');
}
export function matchesResultCategory(item: { category?: string; title: string; kind?: string }, value: string) {
  return value === 'all' || (value === 'files' ? !!item.kind && item.kind !== 'contribution' : resultCategory(item) === value);
}
export function orderedResults<T extends ResultState>(items: T[]) {
  const rank = (item: T) => resultCategory(item) === 'todo' ? effectiveResultStatus(item) === 'completed' ? 1 : effectiveResultStatus(item) === 'cancelled' ? 2 : 0 : 0;
  return [...items].sort((a, b) => rank(a) - rank(b));
}
