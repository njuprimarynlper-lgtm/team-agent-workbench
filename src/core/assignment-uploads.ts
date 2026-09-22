import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicJson } from './store';
import { freezeFile, hashFile } from './artifacts';
import { accountIdentity } from '../shared/account-data';
import type { RemoteBinding, SourceFile } from '../shared/types';
import type { AssignmentUpload } from '../shared/assignments';
import { localWithin } from './paths';

// File selection freezes only explicitly selected files. Nothing is uploaded until confirmation.
export class AssignmentUploads {
  constructor(private root: string) {}
  private directory(requestId: string) { return path.join(this.root, 'assignment-uploads', z.string().uuid().parse(requestId)); }
  private async read(binding: RemoteBinding, requestId: string) {
    const directory = this.directory(requestId);
    let value: { owner: string; projectId: string; files: SourceFile[] };
    try { value = JSON.parse(await fs.readFile(path.join(directory, 'index.json'), 'utf8')); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; value = { owner: accountIdentity(binding), projectId: binding.project.id, files: [] }; }
    if (value.owner !== accountIdentity(binding) || value.projectId !== binding.project.id) throw new Error('附件不属于当前账号或项目');
    return { directory, value };
  }
  async select(binding: RemoteBinding, requestId: string, filenames: string[]): Promise<AssignmentUpload[]> {
    const { directory, value } = await this.read(binding, requestId);
    if (value.files.length + filenames.length > 30) throw new Error('单个任务最多选择 30 个本地附件');
    for (const filename of filenames) {
      const stat = await fs.lstat(filename); if (!stat.isFile() || stat.size > 2 * 1024 ** 3) throw new Error('请选择不超过 2 GB 的普通文件');
      value.files.push(await freezeFile(filename, path.join(directory, 'files')));
    }
    await atomicJson(path.join(directory, 'index.json'), value);
    return value.files.map(({ id, name, sha256, size }) => ({ id, name, sha256, size }));
  }
  async files(binding: RemoteBinding, requestId: string, selected: string[]) {
    const { directory, value } = await this.read(binding, requestId);
    const files: SourceFile[] = [];
    for (const id of [...new Set(selected)]) {
      const file = value.files.find(item => item.id === id);
      if (!file || !localWithin(directory, file.localPath) || await hashFile(file.localPath) !== file.sha256) throw new Error('本地附件快照缺失或已变化，请重新选择');
      files.push(file);
    }
    return files;
  }
}
