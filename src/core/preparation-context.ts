import { canonicalCategory } from '../shared/result-model';
import type { ContributionCategory } from '../shared/content';
import { briefFields, type ProjectBrief } from '../shared/project-brief';
import type { Project, ProjectConclusion } from '../shared/types';
import { rankConclusions } from './conclusion-matcher';

export const preparationContextLimit = 6000;
export const preparationContextResultLimit = 8;
export interface ContextResult {
  projectId: string; scope: 'personal' | 'team'; id: string; version: number;
  title: string; category?: ContributionCategory; state: 'current' | 'history'; content: string; updatedAt: string;
  resultStatus?: string; excerpt?: boolean;
}
export interface PreparationContext {
  version: 1; capturedAt: string; project: { id: string; name: string; group?: string };
  brief: Partial<ProjectBrief>; briefRevision?: number; results: ContextResult[];
}
export function cachedPreparationBrief(text: string): Partial<ProjectBrief> {
  const sections = text.split(/^##\s+/m).slice(1), brief: Partial<ProjectBrief> = {};
  for (const section of sections) {
    const newline = section.indexOf('\n'), label = section.slice(0, newline).trim();
    const field = briefFields.find(field => field.label === label);
    if (field) brief[field.key] = section.slice(newline + 1).trim();
  }
  return brief;
}
export function personalContextResults(items: ProjectConclusion[]): ContextResult[] {
  return items.filter(item => !item.deletedAt).flatMap(item => [
    { projectId: item.projectId, scope: 'personal' as const, id: item.id, version: item.version, title: item.title, category: canonicalCategory(item.category), state: item.archived || item.supersededBy ? 'history' as const : 'current' as const, content: item.content, updatedAt: item.updatedAt, resultStatus: item.resultStatus },
    ...(item.versions || []).slice(-2).map(prior => ({ projectId: item.projectId, scope: 'personal' as const, id: item.id, version: prior.version, title: prior.title, category: canonicalCategory(prior.category), state: 'history' as const, content: prior.content, updatedAt: prior.updatedAt, resultStatus: prior.resultStatus })),
  ]);
}
export function buildPreparationContext(project: Project, query: string, candidates: ContextResult[], brief: Partial<ProjectBrief> = {}, briefRevision?: number): PreparationContext {
  const context: PreparationContext = { version: 1, capturedAt: new Date().toISOString(), project: { id: project.id, name: project.name, group: project.groupLabel || project.groupName }, brief: {}, briefRevision, results: [] };
  // Goals, acceptance and constraints have priority over descriptive material.
  for (const key of ['objectives', 'acceptance', 'constraints', 'background', 'scope', 'resources', 'deliverables', 'collaboration'] as const) {
    if (brief[key]) context.brief[key] = brief[key]!.slice(0, ['objectives', 'acceptance', 'constraints'].includes(key) ? 400 : 150);
  }
  const scoped = candidates.filter(item => item.projectId === project.id).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)).slice(0, 300);
  const indexed = scoped.map((item, index) => ({ id: String(index), projectId: project.id, version: item.version, title: item.title, category: item.category, content: item.content.slice(0, 4000), updatedAt: item.updatedAt, sources: [] }));
  const ranked = rankConclusions(indexed, query.slice(-6000), 100, false);
  // Match first, then prefer current evidence when relevance is otherwise equal.
  ranked.sort((a, b) => b.score - a.score || Number(scoped[+a.conclusion.id].state === 'history') - Number(scoped[+b.conclusion.id].state === 'history'));
  for (const match of ranked) {
    if (context.results.length >= preparationContextResultLimit) break;
    const candidate = scoped[+match.conclusion.id];
    const bounded = { ...candidate, title: candidate.title.slice(0, 120), content: candidate.content.slice(0, 700), excerpt: candidate.content.length > 700 };
    const prospective = { ...context, results: [...context.results, bounded] };
    while (bounded.content.length && JSON.stringify(prospective).length > preparationContextLimit) { bounded.content = bounded.content.slice(0, -100); bounded.excerpt = true; }
    if (!bounded.content || JSON.stringify(prospective).length > preparationContextLimit) continue;
    context.results.push(bounded);
  }
  return context;
}
