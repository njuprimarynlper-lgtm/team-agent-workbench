import type { AgentSession, SourceFile } from './types';

/** Compact renderer metadata; full conversation bodies stay in the main process. */
export interface SessionReferenceReceipts {
  sessionId: string; nativeId?: string; sourceHashes: Record<string, string>;
  acceptedHashes: Record<string, string>; workRecord: boolean;
}

export const isPathReference = (source: SourceFile) => source.referenceMode === 'path';

export const isRecommendationSource = (source: SourceFile) => source.sourcePath.startsWith('rsi-recommendation:');

// Personal, local continuity notes are conversation context, not team result inputs.
export const isPersonalHandoffSource = (source: SourceFile) => source.sourcePath.startsWith('session-handoff:') || source.sourcePath.startsWith('subsession-report:');

// The same snapshot can have multiple IDs in older sessions. Keep different origins
// and different contents separate, even when their display names are identical.
export function sourceIdentity(source: SourceFile) {
  return JSON.stringify([source.sourcePath, source.sha256]);
}

export function uniqueSources(sources: SourceFile[]) {
  const seen = new Set<string>();
  return sources.filter(source => {
    const key = sourceIdentity(source);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// Retain old frozen snapshots for history/export, but never reattach an obsolete
// automatic project brief through a stale draft or queued input. Other files and
// explicitly named comparison materials keep their normal selection behavior.
export function withoutSupersededProjectBrief(session: AgentSession, sources = session.sources) {
  const current = session.sources.find(source => source.id === session.projectBrief?.sourceId);
  if (!current) return sources;
  return sources.filter(source => {
    if (source.id === current.id || source.sourcePath !== current.sourcePath) return true;
    const revision = source.name.match(/^项目说明 · v(\d+)$/);
    return !revision || Number(revision[1]) > session.projectBrief!.revision;
  });
}

// An older native conversation may already have received this snapshot even when
// the current conversation shows it as pending again.
export function sourceWasAccepted(session: AgentSession, source: SourceFile) {
  const ids = new Set(session.sources.filter(item => sourceIdentity(item) === sourceIdentity(source)).map(item => item.id));
  const receipt = session.referenceReceipts;
  if (receipt?.sessionId === session.id && [...ids].some(id => receipt.acceptedHashes[id] === source.sha256)) return true;
  return session.messages.some(message => message.context?.accepted && Object.entries(message.context.sourceHashes).some(([id, hash]) => ids.has(id) && hash === source.sha256));
}

// Match the current native conversation: failed sends and replaced contexts do not count.
export function acceptedSessionContext(session: AgentSession) {
  const receipt = session.referenceReceipts?.sessionId === session.id && session.referenceReceipts.nativeId === session.nativeId ? session.referenceReceipts : undefined;
  const sourceHashes: Record<string, string> = { ...receipt?.sourceHashes };
  let workRecord = receipt?.workRecord || false;
  for (const message of session.messages) {
    const context = message.context;
    if (!context?.accepted || context.nativeId !== session.nativeId) continue;
    Object.assign(sourceHashes, context.sourceHashes);
    workRecord ||= context.workRecord;
  }
  const accepted = new Set(session.sources.filter(source => sourceHashes[source.id] === source.sha256).map(sourceIdentity));
  for (const source of session.sources) if (accepted.has(sourceIdentity(source))) sourceHashes[source.id] = source.sha256;
  return { sourceHashes, workRecord };
}

export function sessionReferenceReceipts(session: AgentSession): SessionReferenceReceipts {
  const ids = new Set(session.sources.map(source => source.id)), acceptedHashes: Record<string, string> = {};
  for (const message of session.messages) if (message.context?.accepted)
    for (const [id, hash] of Object.entries(message.context.sourceHashes)) if (ids.has(id)) acceptedHashes[id] = hash;
  const context = acceptedSessionContext(session);
  return { sessionId: session.id, nativeId: session.nativeId, acceptedHashes, workRecord: context.workRecord,
    sourceHashes: Object.fromEntries(Object.entries(context.sourceHashes).filter(([id]) => ids.has(id))) };
}
