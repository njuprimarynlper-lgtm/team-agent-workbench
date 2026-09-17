import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { atomicJson } from './store';
import { localWithin, remotePath } from './paths';
import type { AdminState } from '../admin/types';

// A test permission registry, NOT an operating-system security boundary.
export interface LocalRegistry { version: 1; administrator: string; credentials: Record<string, string>; state: AdminState }
export const registryPath = '/.workbench-local/registry.json';
export function passwordHash(password: string) { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(password, salt, 32).toString('hex'); }
export function passwordMatches(password: string, hash = '') {
  if (typeof hash !== 'string') return false;
  const [salt, digest] = hash.split(':');
  return !!salt && /^[a-f0-9]{64}$/.test(digest || '') && timingSafeEqual(scryptSync(password, salt, 32), Buffer.from(digest, 'hex'));
}
export async function localRoot(value?: string) {
  if (!value || !path.isAbsolute(value)) throw new Error('请选择已存在的本地共享区绝对路径');
  if ((await fs.lstat(value)).isSymbolicLink() || !(await fs.stat(value)).isDirectory()) throw new Error('共享区必须是普通目录');
  const root = await fs.realpath(value);
  if (root === path.parse(root).root) throw new Error('请使用专用子目录作为共享区');
  return root;
}
export async function diskPath(root: string, logical: string, missing = false) {
  const parts = remotePath(logical).split('/').filter(Boolean);
  if (parts.some(s => /[<>:"|?*]|[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) throw new Error('本地共享路径包含非法文件名');
  const target = path.join(root, ...parts);
  if (!localWithin(root, target)) throw new Error('路径超出共享区');
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('本地共享区不允许符号链接或目录联接');
      if (part && process.platform === 'win32' && !(await fs.readdir(path.dirname(current))).includes(part)) throw new Error('共享路径大小写必须与实际文件名一致');
    }
    catch (e: any) { if (missing && e.code === 'ENOENT') continue; throw e; }
  }
  return target;
}
export async function readRegistry(root: string): Promise<LocalRegistry> {
  const data = JSON.parse(await fs.readFile(await diskPath(root, registryPath), 'utf8'));
  if (data.version !== 1 || !data.state?.initialized || !data.credentials || !data.administrator) throw new Error('本地权限桩配置无效');
  return data;
}
export async function writeRegistry(root: string, registry: LocalRegistry) {
  await atomicJson(await diskPath(root, registryPath, true), registry);
}
export function authorizeUser(data: LocalRegistry, username: string, proof: string) {
  const user = Object.hasOwn(data.state.users, username) ? data.state.users[username] : undefined;
  if (!user?.enabled || !proof || data.credentials[username] !== proof) throw new Error('模拟权限拒绝：账号已停用或凭据已改变，请重新登录');
  return user;
}
export async function registryLock<T>(root: string, action: () => Promise<T>) {
  const file = await diskPath(root, '/.workbench-local.lock', true);
  let lock;
  try { lock = await fs.open(file, 'wx'); } catch (e: any) { if (e.code === 'EEXIST') throw new Error('另一个管理员正在修改本地共享区；若上次进程异常退出，请确认已关闭后移除 .workbench-local.lock'); throw e; }
  try { return await action(); } finally { await lock.close(); await fs.rm(file, { force: true }); }
}
