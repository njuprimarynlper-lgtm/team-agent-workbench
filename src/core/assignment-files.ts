import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assignmentAllFiles, transitionAssignment, assignmentCreateSchema, assignmentStatusSchema, assignmentUploadSchema, type AssignmentCreate, type AssignmentMember, type AssignmentStatusChange, type AssignmentUpload, type ProjectAssignment } from '../shared/assignments';
import type { RemoteBinding } from '../shared/types';
import type { SharedContent } from '../shared/content';
import { diskPath, registryLock } from './local-space';
import { atomicJson } from './store';
import { fileDigests, resolveAssignmentFile, storeAssignmentFile, releaseAssignmentFiles } from './assignment-blobs';

// Local permission simulation; the Linux worker enforces the same rules server-side.
export class AssignmentFiles {
  constructor(private root: string, private authorize: (binding: RemoteBinding) => Promise<{ username: string; admin: boolean; members: AssignmentMember[] }>) {}
  private index(binding: RemoteBinding) {
    if (!/^project_[a-f0-9]{32}$/.test(binding.project.id)) throw new Error('项目身份无效');
    return diskPath(this.root, '/.workbench-local/assignments/' + binding.project.id + '.json', true);
  }
  private async read(binding: RemoteBinding): Promise<ProjectAssignment[]> {
    try { return JSON.parse(await fs.readFile(await this.index(binding), 'utf8')); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async members(binding: RemoteBinding) {
    const actor = await this.authorize(binding); if (!actor.admin) throw new Error('只有本组组管理员可以选择任务负责人'); return actor.members;
  }
  async list(binding: RemoteBinding) {
    const actor = await this.authorize(binding); return (await this.read(binding)).filter(task => !task.purgedAt && (actor.admin || !task.deletedAt && task.assignee === actor.username));
  }
  private async stage(binding: RemoteBinding, actor: string, taskId: string, id: string) {
    z.string().uuid().parse(taskId); z.string().uuid().parse(id);
    const owner = createHash('sha256').update(actor).digest('hex');
    return diskPath(this.root, `/.workbench-local/assignment-stage/${binding.project.id}/${owner}/${taskId}/${id}`, true);
  }
  private async clearStages(binding: RemoteBinding, actor: string, input: { id: string; uploadIds?: string[] }) {
    for (const id of input.uploadIds || []) {
      const file = await this.stage(binding, actor, input.id, id);
      await fs.unlink(file).catch(() => {}); await fs.unlink(file + '.json').catch(() => {});
    }
  }
  upload(binding: RemoteBinding, taskId: string, raw: AssignmentUpload, local: string) {
    const input = assignmentUploadSchema.parse(raw);
    return registryLock(this.root, async () => {
      const actor = await this.authorize(binding), task = (await this.read(binding)).find(item => item.id === taskId);
      if (task ? task.deletedAt || task.purgedAt || task.assignee !== actor.username || task.status !== 'in_progress' : !actor.admin) throw new Error('只有组管理员可以添加派发附件，负责人可在进行中的任务里上传验收附件');
      const file = await this.stage(binding, actor.username, taskId, input.id), hashes = await fileDigests(local);
      if (hashes.sha256 !== input.sha256 || hashes.size !== input.size) throw new Error('任务附件快照校验失败');
      await fs.mkdir(path.dirname(file), { recursive: true });
      try { await fs.copyFile(local, file, fs.constants.COPYFILE_EXCL); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
      if (JSON.stringify(await fileDigests(file)) !== JSON.stringify(hashes)) throw new Error('附件编号已使用');
      const receipt = { ...input, md5: hashes.md5 }; await atomicJson(file + '.json', receipt); return receipt;
    });
  }
  download(binding: RemoteBinding, taskId: string, fileId: string, local: string) {
    return registryLock(this.root, async () => {
      const actor = await this.authorize(binding), task = (await this.read(binding)).find(item => item.id === taskId);
      if (!task || task.purgedAt || !actor.admin && (task.deletedAt || task.assignee !== actor.username)) throw new Error('任务不存在或无权读取附件');
      const file = assignmentAllFiles(task).find(item => item.id === fileId); if (!file) throw new Error('任务附件不存在');
      const blob = await resolveAssignmentFile(this.root, binding.project.id, task.assignee, task.id, file);
      await fs.mkdir(path.dirname(local), { recursive: true }); await fs.copyFile(blob, local, fs.constants.COPYFILE_EXCL); return file;
    });
  }
  create(binding: RemoteBinding, raw: AssignmentCreate) {
    const input = assignmentCreateSchema.parse(raw);
    return registryLock(this.root, async () => {
      const actor = await this.authorize(binding); if (!actor.admin) throw new Error('只有本组组管理员可以派发任务');
      const assignee = actor.members.find(item => item.username === input.assignee); if (!assignee) throw new Error('负责人已停用或不属于此项目组，请刷新成员');
      const tasks = await this.read(binding), existing = tasks.find(item => item.id === input.id);
      if (existing) {
        if (existing.deletedAt || existing.purgedAt) throw new Error('任务已删除，不能重新派发同一编号');
        if (existing.createdBy !== actor.username || ['title', 'description', 'acceptance', 'assignee'].some(key => existing[key as keyof ProjectAssignment] !== input[key as keyof AssignmentCreate]) || JSON.stringify(existing.referenceSelections || existing.references.map(({ id, revision }) => ({ id, revision }))) !== JSON.stringify(input.references) || JSON.stringify(existing.uploadIds || []) !== JSON.stringify(input.uploadIds || [])) throw new Error('任务编号已使用，请重新派发');
        await this.clearStages(binding, actor.username, input); return existing;
      }
      const { references, files } = await this.snapshot(binding, actor.username, input.id, input.assignee, input.references, input.uploadIds || [], '派发人上传');
      const now = new Date().toISOString();
      const task: ProjectAssignment = { ...input, referenceSelections: input.references, files, projectId: binding.project.id, assigneeName: assignee.name, createdBy: actor.username, createdAt: now, updatedAt: now, revision: 1, status: 'assigned', references };
      tasks.unshift(task); await atomicJson(await this.index(binding), tasks); await this.clearStages(binding, actor.username, input); return task;
    });
  }
  private async snapshot(binding: RemoteBinding, username: string, taskId: string, assignee: string, selections: AssignmentCreate['references'], uploadIds: string[], origin: string) {
    let content: SharedContent[] = [];
    try { content = JSON.parse(await fs.readFile(await diskPath(this.root, binding.project.remoteRoot + '/.workbench-content.json'), 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const candidates: { local: string; name: string; sha256: string; size: number; source: string }[] = [];
    const references = await Promise.all(selections.map(async selection => {
      const item = content.find(value => value.id === selection.id && value.revision === selection.revision && ['contribution', 'file'].includes(value.kind));
      if (!item) throw new Error('关联结论已更新或移除，请刷新后重新选择');
      if (item.kind === 'file') {
        if (!item.path.startsWith(binding.project.remoteRoot + '/') || item.path.slice(binding.project.remoteRoot.length + 1).split('/').some(part => part.startsWith('.'))) throw new Error('关联共享文件路径无效');
        candidates.push({ local: await diskPath(this.root, item.path), name: path.posix.basename(item.path), sha256: item.sha256, size: item.size, source: item.title });
      }
      if (selection.attachmentHashes?.some(hash => !item.attachments?.some(file => file.sha256 === hash))) throw new Error('关联附件已变化，请刷新后重新选择');
      for (const file of item.attachments || []) if (!selection.attachmentHashes || selection.attachmentHashes.includes(file.sha256)) {
        if (!file.path.startsWith(binding.project.remoteRoot + '/.workbench-attachments/')) throw new Error('关联附件路径无效');
        candidates.push({ ...file, local: await diskPath(this.root, file.path), source: item.title });
      }
      return { id: item.id, revision: item.revision, title: item.title, category: item.category, kind: item.kind as 'contribution' | 'file', content: item.description, author: item.author, updatedAt: item.updatedAt };
    }));
    for (const id of uploadIds) {
      const file = await this.stage(binding, username, taskId, id), receipt = assignmentUploadSchema.parse(JSON.parse(await fs.readFile(file + '.json', 'utf8')));
      if (receipt.id !== id) throw new Error('任务附件回执无效'); candidates.push({ ...receipt, local: file, source: origin });
    }
    const unique = [...new Map(candidates.map(file => [JSON.stringify([file.name, file.sha256]), file])).values()];
    if (unique.length > 30) throw new Error('单个任务最多关联 30 个文件');
    const files = [];
    for (const file of unique) files.push(await storeAssignmentFile(this.root, binding.project.id, assignee, taskId, file));
    return { references, files };
  }
  status(binding: RemoteBinding, raw: AssignmentStatusChange) {
    const input = assignmentStatusSchema.parse(raw);
    return registryLock(this.root, async () => {
      const actor = await this.authorize(binding), tasks = await this.read(binding), task = tasks.find(item => item.id === input.id);
      if (!task || (!actor.admin && task.assignee !== actor.username)) throw new Error('任务不存在或无权访问');
      const at = new Date().toISOString(), next = transitionAssignment(task, input, actor, at);
      if (next.revision === task.revision) return task;
      if (input.submission) {
        const frozen = await this.snapshot(binding, actor.username, task.id, task.assignee, input.submission.references, input.submission.uploadIds, '负责人提交');
        (next.submissions ||= []).push({ ...frozen, summary: input.submission.summary, submittedBy: actor.username, submittedAt: at });
      }
      tasks[tasks.indexOf(task)] = next;
      await atomicJson(await this.index(binding), tasks);
      if (input.submission) await this.clearStages(binding, actor.username, { id: task.id, uploadIds: input.submission.uploadIds });
      // Persist the tombstone first. A failed cleanup may leak storage but must never break another task.
      if (input.status === 'purged') await releaseAssignmentFiles(this.root, task, tasks).catch(() => {});
      return next;
    });
  }
}
