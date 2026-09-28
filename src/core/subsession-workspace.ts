import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { localWithin } from './paths';

const run = promisify(execFile);
const MAX_FILES = 3000;
const MAX_BYTES = 256 * 1024 * 1024;

function managedTarget(parentCwd: string, storeRoot: string, id: string) {
  const preferred = path.join(storeRoot, 'subsessions', id);
  const fallback = path.join(os.tmpdir(), 'team-agent-subsessions', id);
  const target = localWithin(parentCwd, preferred) ? fallback : preferred;
  if (localWithin(parentCwd, target)) throw new Error('无法在当前工作目录外创建独立的 Subsession 工作区');
  return target;
}

function excluded(relative: string) {
  return relative.split(/[\\/]/).some(part => ['.git', '.workbench', 'node_modules'].includes(part));
}

export interface ForkWorkspace { cwd: string; root: string; kind: 'git-worktree' | 'directory-copy'; baseRevision?: string }

export async function removeForkWorkspace(workspace: ForkWorkspace, parentCwd: string) {
  if (workspace.kind === 'git-worktree') {
    await run('git', ['-C', parentCwd, 'worktree', 'remove', '--force', workspace.root], { timeout: 30000 }).catch(() => {});
  }
  if (localWithin(path.dirname(workspace.root), workspace.root)) await fs.rm(workspace.root, { recursive: true, force: true });
}

/** Make a local, independent code snapshot. This never mutates the parent's tree. */
export async function forkWorkspace(parentCwd: string, storeRoot: string, id: string): Promise<ForkWorkspace> {
  let target = managedTarget(parentCwd, storeRoot, id);
  await fs.mkdir(path.dirname(target), { recursive: true });
  let repository = '';
  try { repository = (await run('git', ['-C', parentCwd, 'rev-parse', '--show-toplevel'], { timeout: 15000 })).stdout.trim(); }
  catch { /* Non-Git workspaces are copied below. */ }
  if (repository) {
    repository = await fs.realpath(repository);
    const canonicalCwd = await fs.realpath(parentCwd);
    if (localWithin(repository, target)) target = path.join(os.tmpdir(), 'team-agent-subsessions', id);
    if (localWithin(repository, target)) throw new Error('无法在 Git 仓库外创建独立工作区');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const relativeCwd = path.relative(repository, canonicalCwd);
    if (relativeCwd.startsWith('..') || path.isAbsolute(relativeCwd)) throw new Error('父会话工作目录不在 Git 仓库内');
    const baseRevision = (await run('git', ['-C', repository, 'rev-parse', 'HEAD'], { timeout: 15000 })).stdout.trim();
    await run('git', ['-C', repository, 'worktree', 'add', '--detach', target, baseRevision], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    try {
      const changed = (await run('git', ['-C', repository, 'diff', '--name-only', '-z', 'HEAD'], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 })).stdout.split('\0').filter(Boolean);
      const untracked = (await run('git', ['-C', repository, 'ls-files', '--others', '--exclude-standard', '-z'], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 })).stdout.split('\0').filter(Boolean);
      const files = [...new Set([...changed, ...untracked])].filter(relative => !excluded(relative));
      if (files.length > MAX_FILES) throw new Error('待复制文件过多，请先清理工作目录');
      let bytes = 0;
      for (const relative of files) {
        const source = path.resolve(repository, relative), destination = path.resolve(target, relative);
        if (!localWithin(repository, source) || !localWithin(target, destination)) throw new Error('Git 文件路径越界');
        const stat = await fs.lstat(source).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
        if (!stat) { await fs.rm(destination, { force: true }); continue; }
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Subsession 暂不复制符号链接或特殊文件：' + relative);
        bytes += stat.size;
        if (bytes > MAX_BYTES) throw new Error('未提交文件超过 256 MB，请先清理工作目录');
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(source, destination);
      }
      return { cwd: path.join(target, relativeCwd), root: target, kind: 'git-worktree', baseRevision };
    } catch (error) {
      await run('git', ['-C', repository, 'worktree', 'remove', '--force', target], { timeout: 30000 }).catch(() => {});
      if (localWithin(path.dirname(target), target)) await fs.rm(target, { recursive: true, force: true });
      throw error;
    }
  }
  let files = 0, bytes = 0;
  try {
    await fs.cp(parentCwd, target, { recursive: true, errorOnExist: true, force: false, filter: async source => {
      const relative = path.relative(parentCwd, source);
      if (relative && (excluded(relative) || localWithin(parentCwd, storeRoot) && localWithin(storeRoot, source) || localWithin(target, source))) return false;
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) throw new Error('Subsession 暂不复制符号链接：' + relative);
      if (stat.isFile()) {
        files++; bytes += stat.size;
        if (files > MAX_FILES || bytes > MAX_BYTES) throw new Error('工作目录副本超过 3000 个文件或 256 MB，请先清理');
      }
      return true;
    } });
    return { cwd: target, root: target, kind: 'directory-copy' };
  } catch (error) {
    if (localWithin(path.dirname(target), target)) await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
}
