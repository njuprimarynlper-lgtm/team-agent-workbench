import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentSession, Draft } from '../shared/types';
import { atomicJson } from './store';
import { writeHandoffAtomic } from './handoff-writer';
import { inspectWorkspaceLinks, compatibleWorkspaceLink, copyWorkspaceLink, verifyWorkspaceLink, validateWorkspaceLinks, type WorkspaceLink, type WorkspaceLinks } from './workspace-links';

type Mapping = { from: string; to: string };
type MetadataRoot = { path: string; resolved: string };
type CopyContext = WorkspaceLinks & { metadataRoots: MetadataRoot[] };
interface CopyPlan { version: 1; from: string; to: string; mappings: Mapping[]; conflicts: string[]; links?: WorkspaceLink[]; metadataRoots?: MetadataRoot[] }
const within = (root: string, file: string) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
const stat = (file: string) => fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
async function digest(file: string) { const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex'); }
async function metadataRootsFor(...workspaces: string[]): Promise<MetadataRoot[]> {
  const roots: MetadataRoot[] = [];
  for (const workspace of new Set(workspaces)) {
    const directory = path.join(workspace, '.workbench');
    if (!(await stat(directory))?.isSymbolicLink()) continue;
    const resolved = await fs.realpath(directory);
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error('会话数据目录不是文件夹：' + directory);
    roots.push({ path: directory, resolved });
  }
  return roots;
}
async function checkMetadataRoots(roots: MetadataRoot[], from: string, to: string) {
  for (const entry of roots) {
    if (![from, to].some(root => path.relative(path.join(root, '.workbench'), entry.path) === '')
      || !(await stat(entry.path))?.isSymbolicLink() || path.relative(await fs.realpath(entry.path), entry.resolved) !== '') {
      throw new Error('会话数据目录链接已变化，原目录已保留：' + entry.path);
    }
  }
}
function metadataPath(file: string, roots: MetadataRoot[]) {
  const root = roots.find(entry => within(entry.path, file));
  return root ? path.join(root.resolved, path.relative(root.path, file)) : file;
}
async function safeParents(root: string, file: string, metadataRoots: MetadataRoot[] = []) {
  if (!within(root, file)) throw new Error('迁移目标超出项目目录');
  let current = root;
  for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await stat(current);
    if (info?.isSymbolicLink()) {
      const entry = metadataRoots.find(item => path.relative(item.path, current) === '');
      if (!entry || path.relative(await fs.realpath(current), entry.resolved) !== '') throw new Error('迁移路径包含已变化或不支持的符号链接：' + current);
    }
  }
}
// Preflight a whole top-level directory. A conflicting repository stays intact
// under one alternate name, rather than mixing individual Git files.
async function compatible(source: string, target: string, links: WorkspaceLinks): Promise<boolean> {
  const a = await fs.lstat(source), b = await stat(target);
  if (a.isSymbolicLink()) return compatibleWorkspaceLink(source, target, links);
  if (b?.isSymbolicLink()) return false;
  if (a.isDirectory()) {
    if (b && !b.isDirectory()) return false;
    for (const name of await fs.readdir(source)) if (!await compatible(path.join(source, name), path.join(target, name), links)) return false;
    return true;
  }
  if (!a.isFile()) throw new Error('无法迁移特殊文件：' + source);
  if (path.basename(source) === '.git' && /^gitdir:/m.test(await fs.readFile(source, 'utf8'))) throw new Error('目录包含独立 Git 工作树或子模块，请保留独立目录：' + source);
  return !b || b.isFile() && a.size === b.size && await digest(source) === await digest(target);
}
async function copyVerified(source: string, target: string, links: CopyContext) {
  await safeParents(links.from, path.dirname(source), links.metadataRoots);
  await safeParents(links.to, path.dirname(target), links.metadataRoots);
  const sourceFile = metadataPath(source, links.metadataRoots), targetFile = metadataPath(target, links.metadataRoots);
  const info = await fs.lstat(sourceFile);
  if (!info.isSymbolicLink() && links.links.some(link => link.source === source)) throw new Error('目录链接在迁移期间发生变化，原目录已保留：' + source);
  if (info.isSymbolicLink()) { await fs.mkdir(path.dirname(targetFile), { recursive: true }); await copyWorkspaceLink(source, target, links); return; }
  await safeParents(links.to, target, links.metadataRoots);
  if (info.isDirectory()) {
    await fs.mkdir(targetFile, { recursive: true });
    for (const name of await fs.readdir(sourceFile)) await copyVerified(path.join(source, name), path.join(target, name), links);
  } else {
    if (!info.isFile()) throw new Error('无法迁移特殊文件：' + source);
    if (path.basename(source) === '.git' && /^gitdir:/m.test(await fs.readFile(sourceFile, 'utf8'))) throw new Error('目录包含独立 Git 工作树或子模块，请保留独立目录：' + source);
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    const hash = await digest(sourceFile);
    const temp = targetFile + '.copy-' + randomUUID();
    try {
      if (!await stat(targetFile)) {
        await fs.copyFile(sourceFile, temp, constants.COPYFILE_EXCL);
        if (await digest(temp) !== hash || await digest(sourceFile) !== hash) throw new Error('复制期间源文件发生变化：' + source);
        try { await fs.link(temp, targetFile); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
      }
    } finally { await fs.rm(temp, { force: true }); }
    if (await digest(targetFile) !== hash || await digest(sourceFile) !== hash) throw new Error('文件发生变化或目标冲突，原文件已保留：' + source);
  }
}

async function verifyCopy(source: string, target: string, links: CopyContext): Promise<void> {
  await safeParents(links.from, path.dirname(source), links.metadataRoots);
  await safeParents(links.to, path.dirname(target), links.metadataRoots);
  const a = await fs.lstat(source), b = await fs.lstat(target);
  if (!a.isSymbolicLink() && links.links.some(link => link.source === source)) throw new Error('目录链接在迁移期间发生变化，原目录已保留：' + source);
  if (a.isSymbolicLink()) { await verifyWorkspaceLink(source, target, links); return; }
  if (b.isSymbolicLink()) throw new Error('校验时目标被替换为目录链接：' + target);
  if (a.isDirectory() && b.isDirectory()) {
    for (const name of await fs.readdir(source)) await verifyCopy(path.join(source, name), path.join(target, name), links);
  } else if (!a.isFile() || !b.isFile() || a.size !== b.size || await digest(source) !== await digest(target)) throw new Error('迁移期间文件发生变化，尚未切换目录：' + source);
}

export function remapWorkspacePath(file: string, mappings: Mapping[]) {
  if (!path.isAbsolute(file)) return file;
  const mapping = [...mappings].sort((a, b) => b.from.length - a.from.length).find(item => within(item.from, file));
  return mapping ? path.join(mapping.to, path.relative(mapping.from, file)) : file;
}

async function materializeHandoff(session: AgentSession, to: string, metadataRoots: MetadataRoot[]) {
  const logical = path.join(to, '.workbench', 'sessions', session.id, 'handoff.md');
  await safeParents(to, logical, metadataRoots);
  const handoff = metadataPath(logical, metadataRoots); await fs.mkdir(path.dirname(handoff), { recursive: true });
  const content = await fs.readFile(session.handoffPath);
  const existing = await fs.readFile(handoff).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (existing && !existing.equals(content)) {
    const logicalBackup = path.join(to, '.workbench', 'directory-imports', session.directoryMove!.id, 'previous-handoff.md');
    await safeParents(to, logicalBackup, metadataRoots);
    const backup = metadataPath(logicalBackup, metadataRoots); await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.writeFile(backup, existing, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
  if (!existing?.equals(content)) await writeHandoffAtomic(handoff, content.toString('utf8'));
}

export async function relocateWorkspace(root: string, session: AgentSession, excludedRoots: string[] = []) {
  const move = session.directoryMove!;
  const from = await fs.realpath(move.from), to = await fs.realpath(move.to);
  if (from === to) { await materializeHandoff(session, to, await metadataRootsFor(to)); return { mappings: [{ from: move.from, to }], conflicts: [] as string[] }; }
  excludedRoots = await Promise.all(excludedRoots.map(item => fs.realpath(item).catch(() => path.resolve(item))));
  if (within(from, to) || within(to, from)) throw new Error('项目目录不能与原工作目录互相包含，请选择独立目录');
  if (excludedRoots.some(item => path.resolve(item) === from || within(path.resolve(item), to))) throw new Error('不能把工作台数据目录作为项目目录');
  const journal = path.join(root, 'directory-moves', move.id + '.json');
  let plan: CopyPlan | undefined;
  try { plan = JSON.parse(await fs.readFile(journal, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (plan && (plan.version !== 1 || plan.from !== from || plan.to !== to)) throw new Error('目录迁移记录不匹配');
  if (!plan) {
    plan = { version: 1, from, to, mappings: [], conflicts: [], metadataRoots: await metadataRootsFor(from, to) };
    const names = (await fs.readdir(from)).filter(name => name !== '.workbench' && !excludedRoots.some(item => within(path.join(from, name), path.resolve(item))));
    const metadata = path.join(from, '.workbench', 'sessions', session.id);
    const metadataExists = !!await stat(metadata);
    if (metadataExists) await safeParents(from, metadata, plan.metadataRoots);
    plan.links = await inspectWorkspaceLinks([...names.map(name => path.join(from, name)), ...(metadataExists ? [metadata] : [])]);
    const suffix = createHash('sha256').update(from).digest('hex').slice(0, 8);
    let destination = to;
    const links: WorkspaceLinks = { from, to, mappings: names.map(name => ({ from: path.join(from, name), to: path.join(to, name) })), links: plan.links };
    if (names.includes('.git')) {
      for (const name of names) if (!await compatible(path.join(from, name), path.join(to, name), links)) {
        destination = path.join(to, path.basename(from) + '.from-' + suffix); plan.conflicts.push(destination); break;
      }
    }
    links.mappings = names.map(name => ({ from: path.join(from, name), to: path.join(destination, name) }));
    for (const name of names) {
      const source = path.join(from, name);
      let target = path.join(destination, name);
      if (!await compatible(source, target, links)) {
        if (destination !== to) throw new Error('迁移保留副本的位置也有冲突：' + target);
        // Sessions sharing one source directory must reuse the same retained copy.
        target = path.join(to, name + '.from-' + suffix); plan.conflicts.push(target);
        links.mappings.find(item => item.from === source)!.to = target;
        if (!await compatible(source, target, links)) throw new Error('迁移保留副本的位置也有冲突：' + target);
      }
      plan.mappings.push({ from: source, to: target });
    }
    // Each session owns this metadata subtree. Conflicts use a retained copy;
    // handoff.md is separately materialized at its canonical location below.
    if (metadataExists) {
      let target = path.join(to, '.workbench', 'sessions', session.id);
      await safeParents(to, target, plan.metadataRoots);
      if (!await compatible(metadata, target, links)) target = path.join(to, '.workbench', 'directory-imports', move.id, session.id);
      plan.mappings.push({ from: metadata, to: target });
    }
    links.mappings = plan.mappings;
    // A retained directory can change a sibling link's new target. Re-check the
    // complete plan before writing, retaining that link separately if necessary.
    for (let pass = 0; pass <= plan.mappings.length; pass++) {
      let changed = false;
      for (const mapping of plan.mappings) if (!await compatible(mapping.from, mapping.to, links)) {
        const alternate = path.join(to, path.basename(mapping.from) + '.from-' + suffix);
        if (destination !== to || mapping.to === alternate || mapping.from === metadata) throw new Error('迁移保留副本的位置也有冲突：' + mapping.to);
        mapping.to = alternate; plan.conflicts.push(alternate); changed = true;
      }
      if (!changed) break;
      if (pass === plan.mappings.length) throw new Error('目录链接与目标内容存在冲突，原目录已保留');
    }
    await atomicJson(journal, plan);
  }
  // Only the metadata root may be an alias. Pin its target across retries;
  // never copy the complete shared root or allow nested session redirects.
  if (!plan.metadataRoots) { plan.metadataRoots = await metadataRootsFor(from, to); await atomicJson(journal, plan); }
  await checkMetadataRoots(plan.metadataRoots, from, to);
  if (!plan.links) { plan.links = await inspectWorkspaceLinks(plan.mappings.map(item => item.from)); await atomicJson(journal, plan); }
  const nestedMetadataLink = plan.links.find(link => within(path.join(from, '.workbench'), link.source));
  if (nestedMetadataLink) throw new Error('会话数据内部包含符号链接，请保留当前目录：' + nestedMetadataLink.source);
  const links: CopyContext = { ...plan, links: plan.links, metadataRoots: plan.metadataRoots };
  await validateWorkspaceLinks(links);
  for (const mapping of plan.mappings) {
    const source = metadataPath(mapping.from, plan.metadataRoots), target = metadataPath(mapping.to, plan.metadataRoots);
    if (path.relative(source, target) !== '' && (within(source, target) || within(target, source))) throw new Error('会话数据目录不能互相包含，原目录已保留');
  }
  for (const mapping of plan.mappings) {
    if (!within(from, mapping.from) || !within(to, mapping.to)) throw new Error('迁移记录路径越界');
    await safeParents(from, path.dirname(mapping.from), plan.metadataRoots);
    await copyVerified(mapping.from, mapping.to, links);
  }
  for (const mapping of plan.mappings) await verifyCopy(mapping.from, mapping.to, links);
  const currentNames = (await fs.readdir(from)).filter(name => name !== '.workbench' && !excludedRoots.some(item => within(path.join(from, name), item)));
  if (currentNames.some(name => !plan!.mappings.some(m => m.from === path.join(from, name)))) throw new Error('迁移期间新增了文件，原目录已保留，请结束其他写入后重新选择项目目录');
  await materializeHandoff(session, to, plan.metadataRoots);
  const mappings = [...plan.mappings, { from, to }];
  // Windows short/extended spellings can appear in legacy records even though
  // filesystem operations resolve the same physical directory.
  return { mappings: [...mappings, ...mappings.map(m => ({ from: path.join(move.from, path.relative(from, m.from)), to: m.to }))], conflicts: plan.conflicts };
}

export function applyWorkspacePaths(session: AgentSession, drafts: Draft[], mappings: Mapping[]) {
  const remap = (file: string) => remapWorkspacePath(file, mappings);
  session.cwd = session.directoryMove!.to;
  session.handoffPath = path.join(session.cwd, '.workbench', 'sessions', session.id, 'handoff.md');
  for (const source of session.sources) source.localPath = remap(source.localPath);
  session.outputFiles = session.outputFiles?.map(remap);
  if (session.fork) { session.fork.workspaceRoot = remap(session.fork.workspaceRoot); if (session.fork.visibleSnapshotPath) session.fork.visibleSnapshotPath = remap(session.fork.visibleSnapshotPath); }
  for (const draft of drafts.filter(draft => draft.sessionId === session.id)) {
    draft.inputDir = remap(draft.inputDir); draft.outputPath = remap(draft.outputPath);
    for (const file of draft.files) file.localPath = remap(file.localPath);
  }
}
