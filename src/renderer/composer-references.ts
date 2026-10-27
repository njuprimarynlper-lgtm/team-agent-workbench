import type { AgentSession, SourceFile } from '../shared/types';
import { acceptedSessionContext, sourceIdentity, sourceWasAccepted, uniqueSources } from '../shared/session-context';
import { isConclusionSource } from '../shared/conclusion-context';
import { isRemovableSessionReference, isProtectedSessionSource } from '../shared/session-result-references';

export function pendingComposerReferences(session: AgentSession, selectedIds: string[]) {
  const hashes = acceptedSessionContext(session).sourceHashes;
  const selected = new Set(session.sources.filter(source => selectedIds.includes(source.id)).map(sourceIdentity));
  return uniqueSources(session.sources).filter(source => hashes[source.id] !== source.sha256).map(source => {
    const automatic = isProtectedSessionSource(session, source) || isConclusionSource(source) || source.sourcePath.startsWith('question:');
    return { source, automatic, selected: automatic || selected.has(sourceIdentity(source)), removable: isRemovableSessionReference(session, source) && !sourceWasAccepted(session, source) };
  }).reverse(); // Most recently attached snapshots remain nearest to More when the window shrinks.
}

export function toggleComposerReference(session: AgentSession, selectedIds: string[], source: SourceFile) {
  const ids = new Set(session.sources.filter(item => sourceIdentity(item) === sourceIdentity(source)).map(item => item.id));
  return selectedIds.some(id => ids.has(id)) ? selectedIds.filter(id => !ids.has(id)) : [...selectedIds, source.id];
}

export const referenceTabMetrics = { waist: 20, overlap: 40, more: 116, minimum: 120, maximum: 180 } as const;

/** Both curved waists overlap completely. Neither hover nor item count changes this geometry. */
export function composerReferenceLayout(availableWidth: number, count: number) {
  const { overlap, more, minimum, maximum } = referenceTabMetrics;
  const available = Math.max(0, Number.isFinite(availableWidth) ? availableWidth : 0);
  const total = Math.max(0, Number.isFinite(count) ? Math.floor(count) : 0);
  if (!total) return { visible: 0, hidden: 0, width: 0, occupied: 0 };
  // First try the complete row without More. Reserving its width up front
  // would hide references that could otherwise fit and create needless overflow.
  const limit = Math.max(minimum, Math.min(maximum, Math.round(available / 3)));
  if (total * (minimum - overlap) + overlap <= available) {
    const width = Math.min(limit, Math.floor((available - overlap) / total + overlap));
    return { visible: total, hidden: 0, width, occupied: total * (width - overlap) + overlap };
  }
  const visible = Math.min(total, Math.max(0, Math.floor((available - more) / (minimum - overlap))));
  const width = visible ? Math.min(limit, Math.floor((available - more) / visible + overlap)) : 0;
  return { visible, hidden: total - visible, width, occupied: visible * (width - overlap) + more };
}
