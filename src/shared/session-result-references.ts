import { accountIdentity } from './account-data';
import { isConclusionSource } from './conclusion-context';
import { isPersonalHandoffSource, sourceIdentity, sourceWasAccepted } from './session-context';
import type { AgentSession, ProjectConclusion, SourceFile } from './types';

export function isLegacyTeamResultSource(session: AgentSession, source: SourceFile) {
  const root = session.binding?.project.remoteRoot.replace(/\/$/, '');
  // Older result imports had a frozen Markdown copy and the original team path,
  // but no contentRef. Do not treat arbitrary local files or project briefs as results.
  if (!root || !source.sourcePath.startsWith(root + '/submissions/')) return false;
  const relative = source.sourcePath.slice(root.length + '/submissions/'.length);
  return relative.includes('/') && !relative.split('/').some(part => !part || part === '..' || part === '.') && / · v\d+$/.test(source.name) && /\.md$/i.test(source.localPath);
}

export function isProtectedSessionSource(session: AgentSession, source: SourceFile) {
  const protectedIds = new Set([session.projectBrief?.sourceId, ...(session.assignment?.sourceIds || []), session.fork?.sourceId, ...(session.fork?.inheritedSourceIds || [])]);
  return session.sources.some(item => protectedIds.has(item.id) && sourceIdentity(item) === sourceIdentity(source));
}

export function isRemovableSessionReference(session: AgentSession, source: SourceFile) {
  return !!(source.contentRef || isConclusionSource(source) || isPersonalHandoffSource(source) || isLegacyTeamResultSource(session, source)) && !isProtectedSessionSource(session, source);
}

// This is a view, not a deletion: retain frozen files and accepted conversation
// history, while excluding unavailable, never-sent results from new inputs.
export function sessionWithAvailableReferences(session: AgentSession, conclusions: ProjectConclusion[]): AgentSession {
  const sources = session.sources.filter(source => {
    if (isProtectedSessionSource(session, source) || sourceWasAccepted(session, source)) return true;
    if (isConclusionSource(source)) {
      const id = source.sourcePath.match(/^local-conclusion:(.+):v\d+$/)![1];
      return conclusions.some(item => item.id === id && !item.deletedAt && item.projectId === session.binding?.project.id && (!item.accountOwner || !!session.binding && item.accountOwner === accountIdentity(session.binding)));
    }
    return !source.resultUnavailable;
  });
  return sources.length === session.sources.length ? session : { ...session, sources };
}
