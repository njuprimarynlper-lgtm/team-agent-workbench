import type { AgentSession, Message } from './types';

export const transcriptPageSize = 160;
export interface TranscriptPage { messages: Message[]; before: number }

export function inheritedMessageCount(session: AgentSession) {
  const fork = session.fork;
  return fork?.visibleSnapshotPath ? fork.visibleMessageCount ?? fork.parentMessageCount : 0;
}
