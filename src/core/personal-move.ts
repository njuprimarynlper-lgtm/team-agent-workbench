import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, Store } from './store';
import type { AgentSession, Draft, ProjectConclusion, SessionInput } from '../shared/types';
import type { JournalRecord } from '../shared/project-journal';
import { randomUUID } from 'node:crypto';
import { resultDirectoryPath, resolveResultFolder, type PersonalResultDirectory } from '../shared/result-directories';

export interface PersonalMove {
  version: 1; targetRoot: string; groupId?: string; retainedConclusions?: ProjectConclusion[]; journals?: JournalRecord[];
  sessions: AgentSession[]; drafts: Draft[]; conclusions: ProjectConclusion[]; inputs: Record<string, SessionInput>;
  directories?: PersonalResultDirectory[];
}
const journal = (root: string) => path.join(root, 'pending-personal-move.json');
export class PersonalMovePendingError extends Error {
  constructor() { super('迁移记录已保留，磁盘保存尚未完成；请检查磁盘后重启工作台恢复迁移，勿重复操作'); }
}
export function applyPersonalMove(store: Store, move: PersonalMove, target: boolean) {
  if (target && move.directories?.length) {
    const ids = new Set(move.directories.map(item => item.id));
    store.settings.resultDirectories = [...(store.settings.resultDirectories || []).filter(item => !ids.has(item.id)), ...structuredClone(move.directories)];
  }
  for (const key of ['sessions', 'drafts', 'conclusions'] as const) {
    const ids = new Set(move[key].map(item => item.id));
    (store[key] as any[]) = [...(target ? structuredClone(move[key]) : key === 'conclusions' ? structuredClone(move.retainedConclusions || []) : []), ...store[key].filter(item => !ids.has(item.id))];
  }
  for (const session of move.sessions) {
    if (target && move.inputs[session.id]) store.inputs[session.id] = structuredClone(move.inputs[session.id]);
    else delete store.inputs[session.id];
    for (const job of store.activity.jobs) if (job.sessionId === session.id && (!target || job.event.projectId !== session.binding?.project.id)) {
      job.status = 'obsolete'; job.ignoredAt ||= new Date().toISOString(); delete job.error; delete job.retryAt;
    }
  }
  if (!target && move.groupId) store.settings.personalGroups = store.settings.personalGroups?.filter(group => group.id !== move.groupId);
}
export async function persistPersonalMove(source: Store, target: Store, move: PersonalMove) {
  // Copy only referenced paths, reuse matching destination paths, and journal
  // generated IDs so crash recovery never duplicates the destination tree.
  if (!move.directories) {
    move.directories = [];
    const available = [...(target.settings.resultDirectories || [])];
    for (const item of move.conclusions) {
      const origin = source.settings.resultDirectories?.find(directory => directory.id === item.folderId);
      if (!origin) continue;
      const accountOwner = item.accountOwner || origin.accountOwner, projectId = item.projectId;
      const sourceDirectories = (source.settings.resultDirectories || []).filter(directory => directory.accountOwner === origin.accountOwner && directory.projectId === origin.projectId);
      const chain = resultDirectoryPath(origin.id, sourceDirectories);
      let parentId = chain[0]?.id || 'exploration';
      for (const node of chain.slice(1)) {
        const destination = available.filter(directory => directory.accountOwner === accountOwner && directory.projectId === projectId);
        let folder = destination.find(directory => !directory.deletedAt && resolveResultFolder(directory.parentId, destination) === parentId && directory.name.normalize('NFC').toLocaleLowerCase() === node.name.normalize('NFC').toLocaleLowerCase());
        if (!folder) { folder = { id: randomUUID(), parentId, name: node.name, revision: 1, accountOwner, projectId }; available.push(folder); move.directories.push(folder); }
        parentId = folder.id;
      }
      item.folderId = parentId;
    }
  }
  await atomicJson(journal(source.root), move);
  applyPersonalMove(target, move, true);
  if (source !== target) applyPersonalMove(source, move, false);
  else if (move.groupId) source.settings.personalGroups = source.settings.personalGroups?.filter(group => group.id !== move.groupId);
  const save = async () => {
    await target.save({ source: 'personal-move:target' });
    if (source !== target) await source.save({ removedSessionIds: move.sessions.map(session => session.id), source: 'personal-move:source' });
    for (const record of move.journals || []) {
      if (!move.sessions.some(session => session.id === record.sessionId)) throw new Error('迁移日志与会话不一致');
      await atomicJson(path.join(target.root, 'project-journals', record.sessionId + '.json'), record);
      if (source !== target) await fs.rm(path.join(source.root, 'project-journals', record.sessionId + '.json'), { force: true });
    }
    await fs.rm(journal(source.root), { force: true });
  };
  try { await save(); }
  catch { // The journal makes a partially written pair recoverable, including app/OS interruption.
    try { await save(); }
    catch { throw new PersonalMovePendingError(); }
  }
}
export async function recoverPersonalMove(sourceRoot: string) {
  let move: PersonalMove;
  try { move = JSON.parse(await fs.readFile(journal(sourceRoot), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  const base = path.dirname(sourceRoot), relative = path.relative(base, move.targetRoot);
  if (move.version !== 1 || !relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('待恢复迁移的目标目录无效');
  const source = new Store(sourceRoot), target = path.resolve(move.targetRoot) === path.resolve(sourceRoot) ? source : new Store(move.targetRoot);
  await source.init(); if (source !== target) await target.init();
  await persistPersonalMove(source, target, move);
}
