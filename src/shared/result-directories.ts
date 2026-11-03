import { z } from 'zod';
import { contributionCategoryInfo } from './content';
import { resultCategories, resultCategory } from './result-model';

export const resultFolderIdSchema = z.union([z.enum(resultCategories), z.string().uuid()]);
export const resultDirectorySchema = z.object({
  id: z.string().uuid(), parentId: resultFolderIdSchema,
  name: z.string().trim().min(1).max(60).refine(value => !/[\x00-\x1f/\\]/u.test(value), '目录名称不能包含斜线或控制字符'),
  revision: z.number().int().positive(), deletedAt: z.string().optional(),
});
export type ResultDirectory = z.infer<typeof resultDirectorySchema>;
export interface PersonalResultDirectory extends ResultDirectory { projectId: string; accountOwner: string }
export const personalResultDirectorySchema = resultDirectorySchema.extend({ projectId: z.string().min(1), accountOwner: z.string().min(1) });
export const resultDirectoryCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), id: z.string().uuid(), parentId: resultFolderIdSchema, name: resultDirectorySchema.shape.name }),
  z.object({ action: z.literal('rename'), id: z.string().uuid(), revision: z.number().int().positive(), name: resultDirectorySchema.shape.name }),
  z.object({ action: z.literal('delete'), id: z.string().uuid(), revision: z.number().int().positive() }),
]);
export type ResultDirectoryCommand = z.infer<typeof resultDirectoryCommandSchema>;
export const resultDirectoryMoveSchema = z.object({
  folderId: resultFolderIdSchema,
  items: z.array(z.object({ id: z.string().uuid(), version: z.number().int().positive(), folderVersion: z.number().int().nonnegative().default(0) })).min(1).max(100)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, '不能重复选择成果'),
});
export type ResultDirectoryMove = z.infer<typeof resultDirectoryMoveSchema>;
export const resultFolderSelectionsSchema = z.record(z.string().min(1).max(100).regex(/^[^\x00-\x1f]+$/u), resultFolderIdSchema);
export interface ResultDirectoryNode { id: string; parentId: string | null; name: string; revision: number; root?: boolean }
export const resultDirectoryRoots: ResultDirectoryNode[] = resultCategories.map(id => ({ id, parentId: null, name: contributionCategoryInfo[id].label, revision: 0, root: true }));
export const isResultDirectoryRoot = (id: string) => resultCategories.includes(id as typeof resultCategories[number]);

// Deleted directories retain their parent as a redirect. Existing references and
// independently synced child directories survive deletion without moving files.
export function resolveResultFolder(id: string | undefined, directories: ResultDirectory[], fallback = 'exploration'): string {
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    if (isResultDirectoryRoot(id)) return id;
    seen.add(id);
    const directory = directories.find(value => value.id === id);
    if (!directory) break;
    if (!directory.deletedAt) return directory.id;
    id = directory.parentId;
  }
  return fallback;
}
export function resultDirectoryNodes(directories: ResultDirectory[]): ResultDirectoryNode[] {
  return [...resultDirectoryRoots, ...directories.filter(value => !value.deletedAt).map(value => ({ ...value, parentId: resolveResultFolder(value.parentId, directories) }))];
}
export function resultDirectoryPath(id: string, directories: ResultDirectory[]): ResultDirectoryNode[] {
  const nodes = resultDirectoryNodes(directories), path: ResultDirectoryNode[] = [], seen = new Set<string>();
  let current = nodes.find(value => value.id === resolveResultFolder(id, directories));
  while (current && !seen.has(current.id)) { seen.add(current.id); path.unshift(current); current = nodes.find(value => value.id === current!.parentId); }
  return path;
}
export const resultDirectoryLabel = (id: string, directories: ResultDirectory[]) => resultDirectoryPath(id, directories).map(value => value.name).join(' / ');
export function resultItemFolder(item: { folderId?: string; category?: string; title: string; kind?: string }, directories: ResultDirectory[]) {
  return resolveResultFolder(item.folderId, directories, resultCategory(item) || 'project_material');
}
export function assertResultFolder(id: string, directories: ResultDirectory[]) {
  resultFolderIdSchema.parse(id);
  if (!isResultDirectoryRoot(id) && !directories.some(value => value.id === id && !value.deletedAt)) throw new Error('所选目录已删除或不存在，请重新选择保存位置');
  return id;
}
export function changeResultDirectory(directories: ResultDirectory[], raw: ResultDirectoryCommand, now = new Date().toISOString()): ResultDirectory[] {
  const command = resultDirectoryCommandSchema.parse(raw), next = structuredClone(directories);
  const existing = next.find(value => value.id === command.id);
  if (command.action === 'create') {
    if (existing) {
      if (!existing.deletedAt && existing.parentId === command.parentId && existing.name === command.name) return next;
      throw new Error('目录标识已存在，请刷新');
    }
    assertResultFolder(command.parentId, next);
    if (resultDirectoryPath(command.parentId, next).length >= 32) throw new Error('目录层级过深');
    if (next.filter(value => !value.deletedAt).length >= 2000) throw new Error('目录数量已达到上限');
    next.push({ id: command.id, parentId: command.parentId, name: command.name, revision: 1 });
  } else {
    if (!existing || existing.deletedAt || existing.revision !== command.revision) throw new Error('目录已更新或删除，请刷新后再操作');
    existing.revision++;
    if (command.action === 'delete') existing.deletedAt = now;
    else existing.name = command.name;
  }
  if (command.action !== 'delete') {
    const directory = next.find(value => value.id === command.id)!;
    const parent = resolveResultFolder(directory.parentId, next);
    if (next.some(value => value.id !== directory.id && !value.deletedAt && resolveResultFolder(value.parentId, next) === parent && value.name.normalize('NFC').toLocaleLowerCase() === directory.name.normalize('NFC').toLocaleLowerCase())) throw new Error('同一级已有这个名称的目录');
  } else {
    const siblings = new Set<string>();
    const promotedParent = resolveResultFolder(command.id, next);
    for (const directory of next.filter(value => !value.deletedAt && resolveResultFolder(value.parentId, next) === promotedParent)) {
      const name = directory.name.normalize('NFC').toLocaleLowerCase();
      if (siblings.has(name)) throw new Error('子目录移到上一级后会重名，请先重命名同名目录再删除');
      siblings.add(name);
    }
  }
  return next;
}
