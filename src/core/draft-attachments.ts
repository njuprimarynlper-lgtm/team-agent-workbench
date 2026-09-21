import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Draft, DraftArtifact } from '../shared/types';
import type { ContentAttachment } from '../shared/content';
import { attachmentPath } from '../shared/attachments';
import { freezeFile, hashFile } from './artifacts';
import type { TransferInput } from './transfers';

export function editableArtifact(draft: Draft, artifactId?: string) {
  if (draft.submitted || draft.artifacts?.some(item => item.submitted) || draft.generation !== 'ready' || draft.mergeSources?.length) throw new Error('请在整理完成、提交前选择附件');
  const artifact = draft.artifacts?.find(item => item.id === artifactId);
  if (!artifact) throw new Error('请选择附件所属的成果');
  return artifact;
}

export async function freezeDraftAttachments(draft: Draft, selected: DraftArtifact[], root: string) {
  const unique = new Map<string, { id: string; local: string }>(), transfers: TransferInput[] = [];
  const byArtifact = new Map<string, { files: ContentAttachment[]; dependsOn: string[] }>();
  for (const artifact of selected) {
    const files: ContentAttachment[] = [], dependsOn: string[] = [];
    for (const entry of artifact.attachments || []) {
      if (!entry.selected) continue;
      const source = draft.files.find(file => file.id === entry.fileId);
      if (!source) throw new Error('附件已不存在，请重新选择');
      if (files.some(file => file.sha256 === source.sha256)) continue;
      if (files.length >= 30) throw new Error('每项成果最多附带 30 个文件');
      if (await hashFile(source.localPath) !== source.sha256) throw new Error('附件快照已改变，请移除后重新添加：' + source.name);
      let blob = unique.get(source.sha256);
      if (!blob) {
        const copy = await freezeFile(source.localPath, path.join(root, 'packages', randomUUID(), 'attachments'));
        if (copy.sha256 !== source.sha256) throw new Error('固定附件时文件发生变化，请重试');
        blob = { id: randomUUID(), local: copy.localPath }; unique.set(source.sha256, blob);
        transfers.push({ ...blob, binding: draft.binding!, folder: draft.binding!.project.uploadPath, kind: 'upload', attachment: true, name: source.name, sessionId: draft.sessionId });
      }
      files.push({ name: source.name, path: attachmentPath(draft.binding!, source.sha256), sha256: source.sha256, size: source.size }); dependsOn.push(blob.id);
    }
    byArtifact.set(artifact.id, { files, dependsOn });
  }
  return { transfers, byArtifact };
}
