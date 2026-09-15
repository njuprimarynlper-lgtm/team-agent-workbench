import path from 'node:path';
import { createHash } from 'node:crypto';
export function remotePath(value: string): string {
  if (!value || !value.startsWith('/') || /[\\\x00-\x1f]/.test(value) || value.split('/').includes('..')) throw new Error('远端路径必须是绝对路径，不能包含 ..、反斜杠或控制字符');
  return path.posix.normalize(value);
}
export function withinRemote(root: string, target: string): boolean {
  const r = remotePath(root).replace(/\/$/, '') || '/';
  const t = remotePath(target);
  return r === '/' || t === r || t.startsWith(r + '/');
}
export function assertRemote(root: string, target: string): string {
  if (!withinRemote(root, target)) throw new Error('目标路径不属于当前项目');
  return remotePath(target);
}
export function childRemote(root: string, name: string): string {
  if (!name || name === '.' || name === '..' || /[\/\\\x00-\x1f]/.test(name)) throw new Error('文件名不合法');
  return remotePath(path.posix.join(root, name));
}
export function safeFilename(name: string): string {
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120);
  return !clean || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? 'file_' + clean : clean;
}
export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export function localWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
