import type { AgentSession } from './types';

export function subsessionParentId(session: AgentSession) {
  return session.fork && !session.fork.promotedAt ? session.parentId || session.fork.parentId : undefined;
}

export function subsessionSiblings(sessions: AgentSession[], session: AgentSession) {
  const parentId = subsessionParentId(session);
  if (!parentId) return [];
  return sessions.filter(value => value.purpose === 'work' && !value.closedAt && subsessionParentId(value) === parentId
    && value.binding?.project.id === session.binding?.project.id);
}

// Keep the side pane within the newly selected parent's family. A direct child
// click overrides this fallback with that exact child in the same UI update.
export function childForSelectedParent(sessions: AgentSession[], parentId: string, previousId: string) {
  const family = subsessionFamily(sessions, parentId).filter(value => value.id !== parentId && value.purpose === 'work' && !value.closedAt);
  return family.find(value => value.id === previousId)?.id || family.find(value => subsessionParentId(value) === parentId)?.id || family[0]?.id || '';
}

// Moving any member keeps the connected family together, including preparation
// records. A promoted branch has its own ownership and no longer follows its parent.
export function sessionMoveFamilyIds(sessions: AgentSession[], seeds: string[]) {
  const selected = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      const parent = session.fork ? subsessionParentId(session) : session.parentId;
      if (!parent || !(selected.has(session.id) || selected.has(parent))) continue;
      for (const id of [session.id, parent]) if (!selected.has(id)) { selected.add(id); changed = true; }
    }
  }
  return selected;
}

export function subsessionFamily(sessions: AgentSession[], id: string): AgentSession[] {
  const result: AgentSession[] = [], seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const session = sessions.find(value => value.id === key);
    if (!session) return;
    result.push(session);
    sessions.filter(value => subsessionParentId(value) === key).forEach(value => visit(value.id));
  };
  visit(id);
  return result;
}

export function quoteSessionText(text: string) {
  return text.trim().split(/\r?\n/).map(line => '> ' + line).join('\n') + '\n\n';
}
