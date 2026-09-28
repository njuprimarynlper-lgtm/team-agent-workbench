import type { AgentSession, ProjectConclusion, SourceFile } from './types';
import { contributionCategoryInfo, currentResultLabel, resultTitle } from './content';

export function conclusionTitle(conclusion: Pick<ProjectConclusion, 'title' | 'titleAlias' | 'category'>) {
  const prior = currentResultLabel(conclusion.title.match(/^【([^】]+)】/)?.[1]?.trim() || '');
  const label = conclusion.category ? contributionCategoryInfo[conclusion.category].label : prior && Object.values(contributionCategoryInfo).some(info => info.label === prior) ? prior : prior === '项目基线变更建议' ? '改进建议' : '项目经验';
  return resultTitle(label, conclusion.titleAlias?.trim() || conclusion.title, 200);
}

export function isConclusionSource(source: SourceFile) {
  return /^local-conclusion:.+:v\d+$/.test(source.sourcePath);
}

export function attachedConclusion(session: AgentSession, conclusionId: string) {
  return session.sources.find(source => isConclusionSource(source) && source.sourcePath.startsWith(`local-conclusion:${conclusionId}:v`));
}
