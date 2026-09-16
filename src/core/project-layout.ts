import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project } from '../shared/types';
import { remotePath, childRemote } from './paths';

export const TRAJECTORY_DIRECTORY = 'trajectories';

export function projectName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('请输入项目名');
  const name = value.trim().normalize('NFC');
  if (!name || name.startsWith('.') || name.endsWith('.') || /[/\\\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name, 'utf8') > 180) {
    throw new Error('项目名不能为空，不能包含路径分隔符或控制字符，不能以点开头或结尾，长度需在 180 字节以内');
  }
  return name;
}

export function newProjectLayout(parent: string, rawName: unknown): Project {
  const name = projectName(rawName), root = childRemote(remotePath(parent), name);
  return { id: 'project_' + randomUUID().replace(/-/g, ''), name, remoteRoot: root, uploadPath: root, historyPath: path.posix.join(root, TRAJECTORY_DIRECTORY) };
}
