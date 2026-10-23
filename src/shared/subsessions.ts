import type { AgentSession } from './types';

export function subsessionParentId(session: AgentSession) {
  return session.fork && !session.fork.promotedAt ? session.parentId || session.fork.parentId : undefined;
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
