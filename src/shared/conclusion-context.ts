import type { AgentSession, ProjectConclusion, SourceFile } from './types';

export function conclusionTitle(conclusion: Pick<ProjectConclusion, 'title' | 'titleAlias'>) {
  return conclusion.titleAlias?.trim() || conclusion.title;
}

export function isConclusionSource(source: SourceFile) {
  return /^local-conclusion:.+:v\d+$/.test(source.sourcePath);
}

export function attachedConclusion(session: AgentSession, conclusionId: string) {
  return session.sources.find(source => isConclusionSource(source) && source.sourcePath.startsWith(`local-conclusion:${conclusionId}:v`));
}
