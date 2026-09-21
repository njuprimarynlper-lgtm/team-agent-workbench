import type { AgentSession, ProjectConclusion, SourceFile } from './types';
import { resultTitle } from './content';

export function conclusionTitle(conclusion: Pick<ProjectConclusion, 'title' | 'titleAlias'>) {
  const prior = conclusion.title.match(/^【([^】]+)】/)?.[1];
  const label = prior && ['项目结论', '项目标准', '方法探索', '问题与风险', '改进建议'].includes(prior) ? prior : prior === '项目基线变更建议' ? '改进建议' : '项目结论';
  return resultTitle(label, conclusion.titleAlias?.trim() || conclusion.title, 200);
}

export function isConclusionSource(source: SourceFile) {
  return /^local-conclusion:.+:v\d+$/.test(source.sourcePath);
}

export function attachedConclusion(session: AgentSession, conclusionId: string) {
  return session.sources.find(source => isConclusionSource(source) && source.sourcePath.startsWith(`local-conclusion:${conclusionId}:v`));
}
