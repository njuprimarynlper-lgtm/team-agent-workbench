import { accountIdentity } from './account-data';
import { normalizedResultBody } from './team-result-difference';
import { titleSubject } from './content';
import { canonicalCategory, resultDefaultStatus } from './result-model';
import type { ProjectConclusion, Transfer } from './types';

export interface ConclusionPublication { version: number; files: string; path: string; sha256: string; at: string }
export interface ConclusionUploadState { status: 'ready' | 'queued' | 'running' | 'done' | 'error'; transferId?: string }
export function uploadFilesKey(files?: { name: string; sha256: string; size: number }[]) {
  return JSON.stringify((files || []).map(({ name, sha256, size }) => [name, sha256, size]).sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }));
}
function ownsUpload(item: ProjectConclusion, transfer: Transfer) {
  return transfer.kind === 'upload' && !transfer.attachment && transfer.metadata?.kind === 'contribution'
    && transfer.binding.project.id === item.projectId && (!item.accountOwner || item.accountOwner === accountIdentity(transfer.binding));
}
export function directPersonalUpload(item: ProjectConclusion, transfer: Transfer) {
  const sources = transfer.metadata?.submission?.sources;
  return ownsUpload(item, transfer) && sources?.length === 1 && sources[0].kind === 'personal_result' && sources[0].id === item.id ? sources[0] : undefined;
}
export function sameUploadedConclusion(item: ProjectConclusion, transfer: Transfer) {
  const metadata = transfer.metadata;
  return !!metadata && normalizedResultBody(item.content) === normalizedResultBody(metadata.description)
    && titleSubject(item.title) === titleSubject(metadata.title)
    && canonicalCategory(item.category) === canonicalCategory(metadata.category)
    && (item.resultStatus ?? resultDefaultStatus(item.category)) === (metadata.resultStatus ?? resultDefaultStatus(metadata.category))
    && item.resultOwner === metadata.resultOwner && uploadFilesKey(item.localFiles) === uploadFilesKey(metadata.attachments);
}
export function conclusionUploadState(item: ProjectConclusion, transfers: Transfer[] = []): ConclusionUploadState {
  const files = uploadFilesKey(item.localFiles), publication = item.publication;
  const matches = transfers.filter(transfer => {
    if (!ownsUpload(item, transfer)) return false;
    if (directPersonalUpload(item, transfer)?.version === item.version && uploadFilesKey(transfer.metadata?.attachments) === files) return true;
    if (publication?.version === item.version && publication.files === files && transfer.target === publication.path && transfer.sha256 === publication.sha256) return true;
    return item.sources.some(source => source.kind === 'session' && (source.id === transfer.conclusionSourceId || source.publication?.path === transfer.target && source.publication.sha256 === transfer.sha256)) && sameUploadedConclusion(item, transfer);
  });
  const done = matches.find(transfer => transfer.status === 'done');
  if (done) return { status: 'done', transferId: done.id };
  if (publication?.version === item.version && publication.files === files
    && !matches.some(transfer => transfer.target === publication.path && transfer.sha256 === publication.sha256 && ['queued', 'running', 'error'].includes(transfer.status))) return { status: 'done' };
  const active = matches.find(transfer => ['queued', 'running'].includes(transfer.status));
  if (active) return { status: active.status as 'queued' | 'running', transferId: active.id };
  const failed = matches.find(transfer => transfer.status === 'error');
  if (failed) return { status: 'error', transferId: failed.id };
  // Legacy exact-origin copies can already be public without a local transfer.
  if (!publication && item.version === 1 && !item.localFiles?.length && item.sources.length === 1) {
    const source = item.sources[0];
    if ((source.kind === 'remote' && item.automatic || source.kind === 'session' && source.publication)
      && source.content && normalizedResultBody(item.content) === normalizedResultBody(source.content)) return { status: 'done' };
  }
  return { status: 'ready' };
}
export function uploadAction(state: ConclusionUploadState) {
  return ({ ready: '分享至团队', queued: '等待上传', running: '上传中', done: '已上传', error: '重试上传' } as const)[state.status];
}
export const uploadBlocked = (state: ConclusionUploadState) => ['done', 'queued', 'running'].includes(state.status);
