import type { AgentSession, Snapshot } from './types';
import { snapshotAccountKey } from './account-scope';
import { transcriptPageSize } from './transcript-page';

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
  return Object.fromEntries((snapshot?.sessions || []).map(session => [session.id, session.historyToken || sessionContentToken(session)]));
}

/** Full metadata, but leave unchanged conversation bodies in the renderer. */
export function compactSnapshotContent(snapshot: Snapshot, accountKey: string | undefined, known: Record<string, string> | undefined, pageMessages = false): Snapshot {
  const sameAccount = !!known && !!accountKey && accountKey === snapshotAccountKey(snapshot);
  if (!sameAccount && !pageMessages) return snapshot;
  return { ...snapshot, sideChats: pageMessages ? snapshot.sideChats?.map(chat => ({ ...chat, session: {
    ...chat.session, messageCount: chat.session.messages.length, messages: chat.session.messages.slice(-transcriptPageSize),
  } })) : snapshot.sideChats, sessions: snapshot.sessions.map(session => {
    const token = sessionContentToken(session);
    const messages = sameAccount && known?.[session.id] === token ? undefined as unknown as AgentSession['messages']
      : pageMessages ? session.messages.slice(-transcriptPageSize) : session.messages;
    return { ...session, messages, ...(pageMessages ? { messageCount: session.messages.length, historyToken: token } : {}) };
  }) };
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
