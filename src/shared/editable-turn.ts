import type { AgentSession } from './types';

export function editableTurnMessage(session: AgentSession) {
  if (session.provider !== 'codex' || session.purpose !== 'work' || !session.nativeId || session.closedAt || session.contextCompacting
    || session.approvals.length || session.inputQueue?.items.length || session.historyEditRecovery
    || !['idle', 'error'].includes(session.status)) return;
  const message = session.messages.findLast(item => item.role === 'user');
  if (!message || message.steering || message.context?.questionRunId || message.context?.accepted === false) return;
  if (message.context && message.context.nativeId !== session.nativeId) return;
  // Imported transcripts can have a clipped body or local-only IDs.
  if (!message.userText && message.text.endsWith('…')) return;
  if (message.nativeItemId || message.id.startsWith('native:') || session.turnTimings?.some(turn => turn.userMessageId === message.id && turn.nativeTurnId)) return message;
}
