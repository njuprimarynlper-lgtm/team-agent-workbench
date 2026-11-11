import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SourceFile } from '../shared/types';
import { isPathReference } from '../shared/session-context';
import { hashFile } from './artifacts';

export function localReferenceKey(file: string) {
  const absolute = path.resolve(file);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

async function readableFile(file: string) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('请选择普通文件');
    return stat;
  } finally { await handle.close(); }
}

// The receipt identifies a path, not the bytes currently stored there. No copy
// or content hash is made: the model reads the original only when it needs it.
export async function linkLocalFile(file: string): Promise<SourceFile> {
  const localPath = path.resolve(file), stat = await readableFile(localPath);
  return { id: randomUUID(), referenceMode: 'path', name: path.basename(localPath), localPath, sourcePath: localPath,
    sha256: createHash('sha256').update('local-path:' + localReferenceKey(localPath)).digest('hex'), size: stat.size, fetchedAt: new Date().toISOString() };
}

export async function assertSourceReadable(source: SourceFile) {
  if (isPathReference(source)) {
    try { await readableFile(source.localPath); }
    catch { throw new Error('本地参考文件不存在或无法读取，请重新选择：' + source.name); }
  } else if (await hashFile(source.localPath) !== source.sha256) throw new Error('参考快照已改变，请重新添加文件：' + source.name);
}
