import type { AgentSession, Snapshot } from './types';
import { snapshotAccountKey } from './account-scope';

// Message events advance storageRevision. The shape check also catches history
// replacement, removal and additions performed outside the streaming path.
export function sessionContentToken(session: AgentSession): string {
  let shape = 2166136261;
  for (const message of session.messages) {
    for (let index = 0; index < message.id.length; index++) shape = Math.imul(shape ^ message.id.charCodeAt(index), 16777619);
    shape = Math.imul(shape ^ message.text.length, 16777619);
  }
  return `${session.storageRevision || 0}:${session.messages.length}:${shape >>> 0}`;
}

export function knownSessionContent(snapshot: Snapshot | undefined): Record<string, string> {
  return Object.fromEntries((snapshot?.sessions || []).map(session => [session.id, sessionContentToken(session)]));
}

/** Full metadata, but leave unchanged conversation bodies in the renderer. */
export function compactSnapshotContent(snapshot: Snapshot, accountKey: string | undefined, known: Record<string, string> | undefined): Snapshot {
  if (!known || !accountKey || accountKey !== snapshotAccountKey(snapshot)) return snapshot;
  return { ...snapshot, sessions: snapshot.sessions.map(session => known[session.id] === sessionContentToken(session)
    ? { ...session, messages: undefined as unknown as AgentSession['messages'] }
    : session) };
}

/** Restore omitted bodies before any component receives the snapshot. */
export function hydrateSnapshotContent(next: Snapshot, current: Snapshot | undefined): Snapshot | undefined {
  if (!next.sessions.some(session => !session.messages)) return next;
  if (!current || snapshotAccountKey(next) !== snapshotAccountKey(current)) return undefined;
  const previous = new Map(current.sessions.map(session => [session.id, session]));
  if (next.sessions.some(session => !session.messages && !previous.has(session.id))) return undefined;
  return { ...next, sessions: next.sessions.map(session => {
    if (session.messages) return session;
    return { ...session, messages: previous.get(session.id)!.messages };
  }) };
}
