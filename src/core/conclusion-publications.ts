import { directPersonalUpload, sameUploadedConclusion, uploadFilesKey } from '../shared/conclusion-upload';
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
    for (const item of conclusions) {
      const direct = directPersonalUpload(item, transfer);
      if (item.deletedAt || !direct?.version) continue;
      const publication = { version: direct.version, files: uploadFilesKey(transfer.metadata?.attachments), path: transfer.target, sha256: transfer.sha256, at: transfer.completedAt || transfer.createdAt };
      if (item.publication && (item.publication.version > publication.version || item.publication.version === publication.version && item.publication.at >= publication.at)) continue;
      item.publication = publication; changed = true;
    }
    if (!sourceId) continue;
    for (const conclusion of conclusions) {
      if (conclusion.deletedAt || conclusion.projectId !== projectId || conclusion.accountOwner && conclusion.accountOwner !== owner) continue;
      for (const source of conclusion.sources) {
        if (source.kind !== 'session' || source.id !== sourceId) continue;
        // Publishing a new artifact creates revision 1 on both sharing backends.
        // Never adopt a later team revision just because the upload path matches.
        if (!source.publication) { source.publication = { path: transfer.target, sha256: transfer.sha256, revision: 1 }; changed = true; }
        if (source.publication.path === transfer.target && source.publication.sha256 === transfer.sha256 && sameUploadedConclusion(conclusion, transfer)) {
          const publication = { version: conclusion.version, files: uploadFilesKey(transfer.metadata.attachments), path: transfer.target, sha256: transfer.sha256, at: transfer.completedAt || transfer.createdAt };
          if (!conclusion.publication || conclusion.publication.version < publication.version || conclusion.publication.version === publication.version && conclusion.publication.at < publication.at) {
            conclusion.publication = publication; changed = true;
          }
        }
      }
    }
  }
  return changed;
}
