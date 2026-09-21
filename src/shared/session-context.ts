import type { AgentSession, SourceFile } from './types';

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

// Match the current native conversation: failed sends and replaced contexts do not count.
export function acceptedSessionContext(session: AgentSession) {
  const sourceHashes: Record<string, string> = {};
  let workRecord = false;
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
