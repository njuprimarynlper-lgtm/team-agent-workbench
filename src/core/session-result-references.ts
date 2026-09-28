import { accountIdentity } from '../shared/account-data';
import { isLegacyTeamResultSource } from '../shared/session-result-references';
import type { SharedContent } from '../shared/content';
import type { AgentSession, RemoteBinding } from '../shared/types';

// Only a successful complete scan (including archived results) proves absence.
// Offline/failed/older-server scans must never invalidate a frozen reference.
export function reconcileTeamResultReferences(sessions: AgentSession[], binding: RemoteBinding, items: SharedContent[], complete: boolean, deleted: SharedContent[] = []) {
  let changed = false;
  for (const session of sessions) {
    if (session.purpose !== 'work' || session.binding?.project.id !== binding.project.id || accountIdentity(session.binding) !== accountIdentity(binding)) continue;
    for (const source of session.sources) {
      if (source.contentRef ? source.contentRef.projectId !== binding.project.id : !isLegacyTeamResultSource(session, source)) continue;
      const matches = (item: SharedContent) => source.contentRef ? item.id === source.contentRef.id : item.path === source.sourcePath;
      const found = items.find(item => !item.deletedAt && matches(item));
      if (found && !source.contentRef) {
        const revision = Number(source.name.match(/ · v(\d+)$/)?.[1]);
        source.contentRef = { projectId: binding.project.id, id: found.id, revision: revision || found.revision }; changed = true;
      }
      const unavailable = !found && (complete || deleted.some(matches) || items.some(item => !!item.deletedAt && matches(item)));
      if (unavailable && !source.resultUnavailable) { source.resultUnavailable = true; changed = true; }
      else if (found && source.resultUnavailable) { delete source.resultUnavailable; changed = true; }
    }
  }
  return changed;
}
