import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { diskPath } from './local-space';
import { assignmentAllFiles, type AssignmentFile, type ProjectAssignment } from '../shared/assignments';

export async function fileDigests(file: string) {
  const sha = createHash('sha256'), md5 = createHash('md5'); let size = 0;
  for await (const data of createReadStream(file)) { sha.update(data); md5.update(data); size += data.length; }
  return { sha256: sha.digest('hex'), md5: md5.digest('hex'), size };
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope = (projectId: string, assignee: string) => digest([projectId, assignee, 'group-admins']);

// Local mode mirrors the Linux worker's permission partition. It is not an OS privacy boundary.
export async function storeAssignmentFile(root: string, projectId: string, assignee: string, taskId: string, input: { local: string; name: string; sha256: string; size: number; source: string }): Promise<AssignmentFile> {
  const hashes = await fileDigests(input.local);
  if (hashes.sha256 !== input.sha256 || hashes.size !== input.size) throw new Error('任务附件校验失败');
  const id = digest([input.name, hashes.sha256]);
  const blob = await diskPath(root, `/.workbench-local/assignment-blobs/${scope(projectId, assignee)}/${hashes.md5}/${hashes.sha256}-${hashes.size}`, true);
  await fs.mkdir(path.dirname(blob), { recursive: true });
  try { await fs.copyFile(input.local, blob, fs.constants.COPYFILE_EXCL); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  if (JSON.stringify(await fileDigests(blob)) !== JSON.stringify(hashes)) throw new Error('去重文件已损坏，不会覆盖');
  const parent = await diskPath(root, `/.workbench-local/assignment-links/${projectId}/${taskId}`, true); await fs.mkdir(parent, { recursive: true });
  const link = path.join(parent, id);
  try {
    // Windows local simulation uses hard links; production Linux always uses symlinks.
    if (process.platform === 'win32') await fs.link(blob, link); else await fs.symlink(path.relative(parent, blob), link, 'file');
  } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  const result = { id, name: input.name, ...hashes, path: `/.workbench-local/assignment-links/${projectId}/${taskId}/${id}`, source: input.source };
  await resolveAssignmentFile(root, projectId, assignee, taskId, result); return result;
}

export async function resolveAssignmentFile(root: string, projectId: string, assignee: string, taskId: string, file: AssignmentFile) {
  if (!/^[a-f0-9]{64}$/.test(file.id) || !/^[a-f0-9]{32}$/.test(file.md5) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('任务附件身份无效');
  const parent = await diskPath(root, `/.workbench-local/assignment-links/${projectId}/${taskId}`), link = path.join(parent, file.id);
  const blob = await diskPath(root, `/.workbench-local/assignment-blobs/${scope(projectId, assignee)}/${file.md5}/${file.sha256}-${file.size}`);
  if (file.path !== `/.workbench-local/assignment-links/${projectId}/${taskId}/${file.id}`) throw new Error('任务附件路径无效');
  const stat = await fs.lstat(link);
  if (stat.isSymbolicLink()) { if (await fs.realpath(link) !== await fs.realpath(blob)) throw new Error('任务附件链接越界'); }
  else if (process.platform !== 'win32' || (await fs.stat(blob)).ino !== stat.ino) throw new Error('任务附件链接无效');
  const hashes = await fileDigests(blob);
  if (hashes.sha256 !== file.sha256 || hashes.md5 !== file.md5 || hashes.size !== file.size) throw new Error('任务附件存储校验失败');
  return blob;
}

// Called under the registry lock after persisting a purge tombstone. Deleted-but-recoverable
// tasks and every past submission still hold references. Never touch shared-source files.
export async function releaseAssignmentFiles(root: string, task: ProjectAssignment, remaining: ProjectAssignment[]) {
  const retained = remaining.filter(item => !item.purgedAt && item.projectId === task.projectId && item.assignee === task.assignee).flatMap(assignmentAllFiles);
  const unused = new Map<string, string>();
  for (const file of new Map(assignmentAllFiles(task).map(file => [file.id, file])).values()) {
    const blob = await resolveAssignmentFile(root, task.projectId, task.assignee, task.id, file);
    const parent = await diskPath(root, `/.workbench-local/assignment-links/${task.projectId}/${task.id}`);
    await fs.unlink(path.join(parent, file.id));
    if (!retained.some(item => item.md5 === file.md5 && item.sha256 === file.sha256 && item.size === file.size)) {
      // Another name in the same task can still point at this blob; remove it only after all links.
      unused.set(blob, blob);
    }
  }
  for (const blob of unused.values()) await fs.unlink(blob);
}
