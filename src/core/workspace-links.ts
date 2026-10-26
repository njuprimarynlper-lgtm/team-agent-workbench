import fs from 'node:fs/promises';
import path from 'node:path';

export type WorkspaceMapping = { from: string; to: string };
export type WorkspaceLink = { source: string; raw: string; target: string; directory: boolean };
export type WorkspaceLinks = { from: string; to: string; mappings: WorkspaceMapping[]; links: WorkspaceLink[] };
const within = (root: string, file: string) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
const same = (a: string, b: string) => path.relative(a, b) === '';
const stat = (file: string) => fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
const absolute = (raw: string, parent: string) => path.resolve(parent, raw.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[a-z]:\\)/i, ''));

// Inspect directory entries, never traverse through a link. The directory graph
// detects internal cycles (including A/link -> B, B/link -> A) before any copy.
export async function inspectWorkspaceLinks(roots: string[]): Promise<WorkspaceLink[]> {
  const links: WorkspaceLink[] = [], graph = new Map<string, string[]>();
  const visit = async (file: string) => {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink()) {
      const raw = await fs.readlink(file);
      const target = absolute(raw, path.dirname(file));
      const resolved = await fs.realpath(file).catch(error => {
        throw new Error((error.code === 'ELOOP' ? '目录链接形成循环' : '目录链接的目标不可访问') + '，原目录已保留：' + file);
      });
      const targetInfo = await fs.stat(file);
      if (!targetInfo.isDirectory() && !targetInfo.isFile()) throw new Error('链接指向特殊文件，原目录已保留：' + file);
      const directory = targetInfo.isDirectory();
      links.push({ source: file, raw, target, directory });
      if (directory) graph.set(file, [resolved]);
    } else if (info.isDirectory()) {
      const children = (await fs.readdir(file)).map(name => path.join(file, name));
      graph.set(file, children);
      for (const child of children) await visit(child);
    }
  };
  for (const root of roots) await visit(root);
  // Include the workspace root so links to an ancestor are cycles too.
  for (const root of roots) {
    const parent = path.dirname(root);
    if (!graph.has(parent)) graph.set(parent, roots.filter(item => same(path.dirname(item), parent)));
  }
  const complete = new Set<string>(), active = new Set<string>();
  const check = (file: string) => {
    if (!graph.has(file) || complete.has(file)) return;
    if (active.has(file)) throw new Error('目录链接形成循环，原目录已保留：' + file);
    active.add(file);
    for (const child of graph.get(file)!) check(child);
    active.delete(file); complete.add(file);
  };
  for (const file of graph.keys()) check(file);
  return links;
}

export function mappedLinkTarget(link: WorkspaceLink, context: WorkspaceLinks) {
  if (same(link.target, context.from)) return context.to;
  const mapping = [...context.mappings].sort((a, b) => b.from.length - a.from.length).find(item => within(item.from, link.target));
  // Excluded/unmoved files retain their original targets, just like external links.
  return mapping ? path.join(mapping.to, path.relative(mapping.from, link.target)) : link.target;
}

async function checkedLink(source: string, context: WorkspaceLinks) {
  const link = context.links.find(item => same(item.source, source));
  if (!link || await fs.readlink(source) !== link.raw || !same(link.target, absolute(link.raw, path.dirname(source)))) throw new Error('目录链接在迁移期间发生变化，原目录已保留：' + source);
  return link;
}

export async function compatibleWorkspaceLink(source: string, destination: string, context: WorkspaceLinks) {
  const link = await checkedLink(source, context), target = mappedLinkTarget(link, context), existing = await stat(destination);
  if (!existing) return true;
  if (existing.isSymbolicLink()) return same(absolute(await fs.readlink(destination), path.dirname(destination)), target);
  // A common case: old/docs already points to new/docs. Reuse that directory
  // without recopying its contents, replacing it, or writing through the old link.
  if (existing.isDirectory() !== link.directory) return false;
  const resolved = await fs.realpath(destination);
  return same(resolved, await fs.realpath(target).catch(() => target));
}

export async function copyWorkspaceLink(source: string, destination: string, context: WorkspaceLinks) {
  const link = await checkedLink(source, context), target = mappedLinkTarget(link, context);
  const existing = await stat(destination);
  if (existing) {
    if (!await compatibleWorkspaceLink(source, destination, context)) throw new Error('目标目录已有不同内容，原目录已保留：' + destination);
    return;
  }
  if (same(target, destination) || link.directory && within(target, destination)) throw new Error('迁移后目录链接会指向自身或上级目录，原目录已保留：' + source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  // Absolute external targets stay external; internal targets use the completed
  // copy plan, including retained conflict directories. Never dereference-copy.
  const type = link.directory ? process.platform === 'win32' ? 'junction' : 'dir' : 'file';
  const pointer = type === 'junction' || path.isAbsolute(link.raw) ? target : path.relative(path.dirname(destination), target);
  try { await fs.symlink(pointer, destination, type); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw new Error('无法在新目录保留文件链接，原目录已保留：' + source + '（' + error.code + '）');
  }
  if (!await compatibleWorkspaceLink(source, destination, context)) throw new Error('目标目录链接已变化，原目录已保留：' + destination);
}

export async function verifyWorkspaceLink(source: string, destination: string, context: WorkspaceLinks) {
  if (!await stat(destination) || !await compatibleWorkspaceLink(source, destination, context)) throw new Error('目录链接未能完整保留，尚未切换工作目录：' + source);
}

export async function validateWorkspaceLinks(context: WorkspaceLinks) {
  for (const link of context.links) {
    await checkedLink(link.source, context);
    const mapping = [...context.mappings].sort((a, b) => b.from.length - a.from.length).find(item => within(item.from, link.source));
    if (!mapping) throw new Error('目录链接不属于本次迁移：' + link.source);
    const destination = path.join(mapping.to, path.relative(mapping.from, link.source)), target = mappedLinkTarget(link, context);
    if (!await stat(destination) && (same(target, destination) || link.directory && within(target, destination))) throw new Error('迁移后目录链接会指向自身或上级目录，原目录已保留：' + link.source);
  }
}
