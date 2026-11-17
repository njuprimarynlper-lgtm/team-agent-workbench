import type { AgentSession } from '../shared/types';

/** A newly selected work session may replace the old source of a question. */
export function questionWorkSession(current: AgentSession | undefined, linked: AgentSession | undefined, projectId: string) {
  const usable = (session: AgentSession | undefined): session is AgentSession => !!session && session.binding?.project.id === projectId && session.purpose === 'work' && !session.closedAt && !session.cursorNative;
  return usable(current) ? current : usable(linked) ? linked : undefined;
}
