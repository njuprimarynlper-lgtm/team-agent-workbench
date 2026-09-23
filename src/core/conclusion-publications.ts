import { accountIdentity } from '../shared/account-data';
import type { Draft, ProjectConclusion, Transfer } from '../shared/types';

// Upload targets include a unique transfer ID. Keep that exact origin rather
// than inferring identity from a title or from similar text in another result.
export function linkConclusionPublications(conclusions: ProjectConclusion[], drafts: Draft[], transfers: Transfer[]) {
  let changed = false;
  for (const transfer of transfers) {
    if (transfer.status !== 'done' || transfer.kind !== 'upload' || transfer.attachment || transfer.metadata?.kind !== 'contribution' || !transfer.sha256) continue;
    const owner = accountIdentity(transfer.binding), projectId = transfer.binding.project.id;
    let sourceId = transfer.conclusionSourceId;
    if (!sourceId) {
      for (const draft of drafts) {
        if (!draft.binding || draft.binding.project.id !== projectId || accountIdentity(draft.binding) !== owner) continue;
        sourceId = draft.artifacts?.find(artifact => artifact.submitted === transfer.id)?.id;
        if (!sourceId && !draft.artifacts?.length && draft.submitted === transfer.id) sourceId = draft.id;
        if (sourceId) break;
      }
    }
    if (!sourceId) continue;
    for (const conclusion of conclusions) {
      if (conclusion.deletedAt || conclusion.projectId !== projectId || conclusion.accountOwner && conclusion.accountOwner !== owner) continue;
      for (const source of conclusion.sources) {
        if (source.kind !== 'session' || source.id !== sourceId || source.publication) continue;
        // Publishing a new artifact creates revision 1 on both sharing backends.
        // Never adopt a later team revision just because the upload path matches.
        source.publication = { path: transfer.target, sha256: transfer.sha256, revision: 1 };
        changed = true;
      }
    }
  }
  return changed;
}
