import type { AgentSession } from './types';

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
  return { sourceHashes, workRecord };
}
