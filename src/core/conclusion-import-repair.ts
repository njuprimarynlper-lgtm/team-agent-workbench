import { createHash } from 'node:crypto';
import type { ContentUpdate, ProjectConclusion } from '../shared/types';
import { conclusionTitle } from '../shared/conclusion-context';

// Older imports appended a different remote ID to a related document without
// incorporating its content. Repair only links proven by a saved-import action.
// Explicit AI merges use kind="conclusion" snapshots and are never split here.
export function repairConclusionImports(conclusions: ProjectConclusion[], updates: ContentUpdate[], legacyOwner = '') {
  let changed = false;
  for (const item of [...conclusions]) {
    if (item.deletedAt || item.archived) continue;
    const misplaced = item.sources.slice(1).filter(source => source.kind === 'remote' && source.content?.trim());
    for (const source of misplaced) {
      const actions = updates.filter(event => event.projectId === item.projectId && event.id === source.id)
        .flatMap(event => event.actions || []).filter(action => action.kind === 'saved_conclusion' && action.targetId === item.id && action.sourceRevision === source.revision);
      if (!actions.length) continue;
      const sameOrigin = conclusions.filter(candidate => candidate.projectId === item.projectId && candidate.accountOwner === item.accountOwner
        && candidate.sources.length === 1 && candidate.sources[0].kind === 'remote' && candidate.sources[0].id === source.id);
      // A user's explicit removal/archive wins over automatic recovery.
      if (sameOrigin.some(candidate => candidate.deletedAt || candidate.archived)) continue;
      let target = sameOrigin.find(candidate => candidate.sources[0].revision === source.revision);
      if (!target && sameOrigin.length) continue;
      if (!target) {
        // Identical repairs on two computers converge on the same material ID.
        const hash = createHash('sha256').update(JSON.stringify(['import-link-repair-v1', item.accountOwner || legacyOwner, item.projectId, source.id, source.revision])).digest('hex');
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        if (conclusions.some(candidate => candidate.id === id)) continue;
        target = { id, projectId: item.projectId, ...(item.accountOwner ? { accountOwner: item.accountOwner } : {}), title: conclusionTitle({ title: source.title }), content: source.content!, sources: [structuredClone(source)], updatedAt: source.updatedAt, version: 1, automatic: true };
        conclusions.unshift(target);
      }
      for (const action of actions) {
        action.correctedFromTitle = action.targetTitle || conclusionTitle(item);
        action.targetId = target.id; action.targetTitle = conclusionTitle(target); action.sourceTitle = source.title;
      }
      // Retain the edited/merged document itself and every frozen Session copy.
      item.sources = item.sources.filter(value => value !== source); item.version++;
      changed = true;
    }
  }
  for (const event of updates) for (const action of event.actions || []) {
    if (action.kind !== 'saved_conclusion' || action.sourceTitle) continue;
    const source = conclusions.find(item => item.projectId === event.projectId && item.id === action.targetId)?.sources
      .find(source => source.kind === 'remote' && source.id === event.id && source.revision === action.sourceRevision);
    if (source) { action.sourceTitle = source.title; changed = true; }
  }
  return changed;
}
