import fs from 'node:fs/promises';
import { assignmentCreateSchema, assignmentStatusSchema, type AssignmentCreate, type AssignmentMember, type AssignmentStatusChange, type ProjectAssignment } from '../shared/assignments';
import type { RemoteBinding } from '../shared/types';
import type { SharedContent } from '../shared/content';
import { diskPath, registryLock } from './local-space';
import { atomicJson } from './store';

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
    const actor = await this.authorize(binding); if (!actor.admin) throw new Error('只有本组子管理员可以选择任务负责人'); return actor.members;
  }
  async list(binding: RemoteBinding) {
    const actor = await this.authorize(binding); return (await this.read(binding)).filter(task => actor.admin || task.assignee === actor.username);
  }
  create(binding: RemoteBinding, raw: AssignmentCreate) {
    const input = assignmentCreateSchema.parse(raw);
    return registryLock(this.root, async () => {
      const actor = await this.authorize(binding); if (!actor.admin) throw new Error('只有本组子管理员可以派发任务');
      const assignee = actor.members.find(item => item.username === input.assignee); if (!assignee) throw new Error('负责人已停用或不属于此项目组，请刷新成员');
      const tasks = await this.read(binding), existing = tasks.find(item => item.id === input.id);
      if (existing) {
        if (existing.createdBy !== actor.username || ['title', 'description', 'acceptance', 'assignee'].some(key => existing[key as keyof ProjectAssignment] !== input[key as keyof AssignmentCreate]) || JSON.stringify(existing.references.map(({ id, revision }) => ({ id, revision }))) !== JSON.stringify(input.references)) throw new Error('任务编号已使用，请重新派发');
        return existing;
      }
      let content: SharedContent[] = [];
      try { content = JSON.parse(await fs.readFile(await diskPath(this.root, binding.project.remoteRoot + '/.workbench-content.json'), 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      const references = input.references.map(selection => {
        const item = content.find(value => value.id === selection.id && value.revision === selection.revision && value.kind === 'contribution');
        if (!item) throw new Error('关联结论已更新或移除，请刷新后重新选择');
        return { id: item.id, revision: item.revision, title: item.title, content: item.description, author: item.author, updatedAt: item.updatedAt };
      });
      const now = new Date().toISOString();
      const task: ProjectAssignment = { ...input, projectId: binding.project.id, assigneeName: assignee.name, createdBy: actor.username, createdAt: now, updatedAt: now, revision: 1, status: 'assigned', references };
      tasks.unshift(task); await atomicJson(await this.index(binding), tasks); return task;
    });
  }
  status(binding: RemoteBinding, raw: AssignmentStatusChange) {
    const input = assignmentStatusSchema.parse(raw);
    return registryLock(this.root, async () => {
      const actor = await this.authorize(binding), tasks = await this.read(binding), task = tasks.find(item => item.id === input.id);
      if (!task || (!actor.admin && task.assignee !== actor.username)) throw new Error('任务不存在或无权访问');
      if (input.status === 'cancelled' ? !actor.admin : task.assignee !== actor.username) throw new Error('只能由负责人开始或完成任务，子管理员可以取消任务');
      if (task.revision !== input.revision) throw new Error('任务状态已更新，请刷新后重试');
      if (task.status === input.status) return task;
      if (['completed', 'cancelled'].includes(task.status) || input.status === 'completed' && task.status !== 'in_progress') throw new Error('当前任务状态不允许此操作');
      task.status = input.status; task.revision++; task.updatedAt = new Date().toISOString();
      await atomicJson(await this.index(binding), tasks); return task;
    });
  }
}
