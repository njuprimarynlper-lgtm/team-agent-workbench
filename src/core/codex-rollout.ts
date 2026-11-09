import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

// Paginated Codex histories retain the full rollout as JSONL compressed with Zstandard.
// App Server paths still name the logical .jsonl file, without the compression suffix.
export const codexRolloutPath = (file: string) => file.replace(/(\.jsonl)\.zst$/i, '$1');

export function canonicalCodexRolloutName(file: string, id: string, createdAt: string) {
  const basename = path.basename(codexRolloutPath(file));
  const match = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([a-f0-9-]{36})\.jsonl$/i.exec(basename);
  if (match?.[1].toLowerCase() === id.toLowerCase()) return basename;
  const created = new Date(createdAt);
  const timestamp = Number.isNaN(created.getTime()) ? new Date() : created;
  return `rollout-${timestamp.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`;
}

export async function existingCodexRollout(file: string) {
  if ((await fs.promises.stat(file).catch(() => undefined))?.isFile()) return file;
  const logical = codexRolloutPath(file), alternate = logical === file ? file + '.zst' : logical;
  return (await fs.promises.stat(alternate).catch(() => undefined))?.isFile() ? alternate : file;
}

export function codexRolloutStream(file: string) {
  if (codexRolloutPath(file) === file) return fs.createReadStream(file);
  if (typeof zlib.createZstdDecompress !== 'function') throw new Error('当前运行环境不支持读取压缩的 Codex 历史，请更新工作台');
  const source = fs.createReadStream(file), decoded = zlib.createZstdDecompress();
  source.on('error', error => decoded.destroy(error));
  decoded.on('close', () => source.destroy());
  return source.pipe(decoded);
}

export async function readCodexRollout(file: string) {
  const chunks: Buffer[] = [];
  for await (const chunk of codexRolloutStream(await existingCodexRollout(file))) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function copyCodexRollout(source: string, destination: string) {
  await pipeline(codexRolloutStream(await existingCodexRollout(source)), fs.createWriteStream(destination, { mode: 0o600 }));
}
