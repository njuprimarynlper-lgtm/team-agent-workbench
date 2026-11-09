import type { AgentSession, Snapshot, WorkbenchEvent } from '../shared/types';

/** Keep a newer streamed session when an in-flight full snapshot arrives late. */
export function mergeNewerSessions(next: Snapshot, current?: Snapshot): Snapshot {
  if (!current) return next;
  const previous = new Map(current.sessions.map(session => [session.id, session]));
  const sessions = next.sessions.map(session => {
    const older = previous.get(session.id);
    return older && (older.storageRevision || 0) > (session.storageRevision || 0) ? older : session;
  });
  const previousChats = new Map(current.sideChats?.map(chat => [chat.id, chat]) || []);
  const sideChats = next.sideChats?.map(chat => {
    const older = previousChats.get(chat.id);
    return older && (older.session.storageRevision || 0) > (chat.session.storageRevision || 0) ? { ...chat, session: older.session } : chat;
  });
  return { ...next, sessions, sideChats };
}

function mergeSession(previous: AgentSession, event: Pick<Extract<WorkbenchEvent, { type: 'session-delta' }>, 'session' | 'messages'>): AgentSession {
  const messages = [...previous.messages];
  const indexes = new Map(messages.map((message, position) => [message.id, position]));
  for (const message of event.messages) {
    const position = indexes.get(message.id);
    if (position === undefined) { indexes.set(message.id, messages.length); messages.push(message); }
    else messages[position] = message;
  }
  return { ...event.session, sources: previous.sources, messages };
}

export function applySessionDelta(current: Snapshot | undefined, event: Extract<WorkbenchEvent, { type: 'session-delta' }>): Snapshot | undefined {
  if (!current) return current;
  const index = current.sessions.findIndex(session => session.id === event.session.id);
  if (index < 0) return current;
  const previous = current.sessions[index];
  if ((previous.storageRevision || 0) > (event.session.storageRevision || 0)) return current;
  const session = mergeSession(previous, event);
  const sessions = [...current.sessions]; sessions[index] = session;
  return { ...current, sessions };
}

export function applySideChatDelta(current: Snapshot | undefined, event: Extract<WorkbenchEvent, { type: 'sidechat-delta' }>): Snapshot | undefined {
  if (!current?.sideChats) return current;
  const index = current.sideChats.findIndex(chat => chat.id === event.chatId && chat.session.id === event.session.id);
  if (index < 0) return current;
  if ((current.sideChats[index].session.storageRevision || 0) > (event.session.storageRevision || 0)) return current;
  const sideChats = [...current.sideChats];
  sideChats[index] = { ...sideChats[index], session: mergeSession(sideChats[index].session, event) };
  return { ...current, sideChats };
}
