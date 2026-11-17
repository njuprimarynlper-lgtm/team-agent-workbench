import fs from 'node:fs/promises';
import path from 'node:path';
import type { AdminState } from './types';
import { diskPath } from '../core/local-space';
import { logsFor, accountLogScope } from '../core/logging';

export type ProjectCatalogItem = { id: string; name: string; group: string; groupLabel: string; path: string };
export type ProjectPurgeMode = 'all' | 'keep_trajectories';
const protectedNames = new Set(['.workbench-project.json', '项目说明.md', '.brief-versions', '.workbench-content.json', '.workbench-content-history.json']);

function unreadableCatalog(root: string, error: any, index = false) {
  logsFor(root).record('diagnostic', 'admin.project_catalog_unreadable', accountLogScope(root, { origin: 'user' }), { level: 'error', detail: error?.message || String(error), stack: error?.stack });
  return Object.assign(new Error(index ? '成果索引暂未读取成功，本次尚未执行删除。请查看日志核对索引文件；修复后重新读取项目，再选择清理方式。' : '项目目录暂未完整读取，无法确认可清理的项目。请重新读取；若仍失败，查看日志核对目录访问。'), { code: index ? 'PROJECT_RESULT_INDEX_UNREADABLE' : 'PROJECT_CATALOG_INCOMPLETE', cause: error });
}

export async function catalogProjects(root: string, state: AdminState): Promise<ProjectCatalogItem[]> {
  const projects: ProjectCatalogItem[] = [];
  for (const [groupId, group] of Object.entries(state.groups || {})) {
    if (!group.workspace || group.provisioning || group.deletedAt || group.purgedAt) continue;
    let entries;
    try { entries = await fs.readdir(await diskPath(root, group.workspace), { withFileTypes: true }); }
    catch (error) { throw unreadableCatalog(root, error); }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(await diskPath(root, group.workspace), entry.name, '.workbench-project.json'), 'utf8'));
        if (!meta || typeof meta.id !== 'string' || typeof meta.name !== 'string') throw new Error('项目登记文件格式无效');
        projects.push({ id: meta.id, name: meta.name, group: groupId, groupLabel: group.label || groupId, path: path.posix.join(group.workspace.replace(/^\//, ''), entry.name) });
      } catch (error: any) { if (error.code !== 'ENOENT') throw unreadableCatalog(root, error); }
    }
  }
  return projects.sort((a, b) => a.groupLabel.localeCompare(b.groupLabel, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'));
}

async function fileCount(directory: string) {
  let count = 0;
  const walk = async (current: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) count++;
    }
  };
  await walk(directory);
  return count;
}

export async function purgeProject(root: string, state: AdminState, projectId: string, mode: ProjectPurgeMode) {
  if (!/^project_[a-f0-9]{32}$/.test(projectId)) throw new Error('项目身份无效');
  if (mode !== 'all' && mode !== 'keep_trajectories') throw new Error('请选择清理方式');
  const matches = (await catalogProjects(root, state)).filter(item => item.id === projectId);
  if (matches.length !== 1) throw new Error('项目不存在或身份重复，已停止清理');
  const found = matches[0], directory = await diskPath(root, '/' + found.path), prefix = '/' + found.path + '/trajectories/';
  const readList = async (name: string) => {
    try { const value = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')); if (!Array.isArray(value)) throw new Error('项目成果索引格式无效'); return value; }
    catch (error: any) { if (error.code === 'ENOENT') return []; throw unreadableCatalog(root, error, true); }
  };
  const trajectory = (entry: { path?: string }) => typeof entry?.path === 'string' && entry.path.startsWith(prefix);
  const items = mode === 'keep_trajectories' ? (await readList('.workbench-content.json')).filter(trajectory) : [];
  const history = mode === 'keep_trajectories' ? (await readList('.workbench-content-history.json')).filter(trajectory) : [];
  let removed = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (protectedNames.has(entry.name) || (mode === 'keep_trajectories' && entry.name === 'trajectories')) continue;
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) { await fs.unlink(target); removed++; }
    else if (entry.isDirectory()) { removed += await fileCount(target); await fs.rm(target, { recursive: true, force: true }); }
    else if (entry.isFile()) { await fs.unlink(target); removed++; }
  }
  await fs.writeFile(path.join(directory, '.workbench-content.json'), JSON.stringify(items), 'utf8');
  await fs.writeFile(path.join(directory, '.workbench-content-history.json'), JSON.stringify(history), 'utf8');
  const receipt = await diskPath(root, '/.workbench-local/upload-receipts.json', true);
  try {
    const data = JSON.parse(await fs.readFile(receipt, 'utf8')) as Record<string, { path?: string }>;
    const projectPrefix = '/' + found.path + '/';
    const trimmed = Object.fromEntries(Object.entries(data).filter(([, value]) => !value?.path?.startsWith(projectPrefix) || (mode === 'keep_trajectories' && value.path.startsWith(prefix))));
    if (Object.keys(trimmed).length !== Object.keys(data).length) await fs.writeFile(receipt, JSON.stringify(trimmed), 'utf8');
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  return { projectId, name: found.name, mode, removedFiles: removed };
}
