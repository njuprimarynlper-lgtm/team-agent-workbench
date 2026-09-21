import type { ContentAttachment } from './content';
import type { RemoteBinding } from './types';
import { accountNameSchema } from './accounts';

// Blobs are project-readable, worker-owned and absent from the public activity index.
export function attachmentPath(binding: RemoteBinding, hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash) || !accountNameSchema.safeParse(binding.username).success) throw new Error('附件身份无效');
  return `${binding.project.remoteRoot}/.workbench-attachments/${binding.username}/${hash}`;
}
export function mergeAttachments(items: { attachments?: ContentAttachment[] }[]) {
  const result: ContentAttachment[] = [];
  for (const item of items) for (const file of item.attachments || []) if (!result.some(other => other.sha256 === file.sha256)) result.push(file);
  if (result.length > 30) throw new Error('合并后的附件超过 30 个，请分批整理');
  return result;
}
