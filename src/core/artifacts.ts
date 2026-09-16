import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { ZipArchive } from 'archiver';
import type { AgentSession, Draft, SourceFile } from '../shared/types';
import { safeFilename, localWithin } from './paths';
export async function hashFile(file: string) {
  const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
export async function freezeFile(source: string, directory: string): Promise<SourceFile> {
  const before = await fsp.lstat(source);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('附件必须是普通文件，请先将目录打包；不接受符号链接');
  if (before.size > 2 * 1024 ** 3) throw new Error('单个附件最大 2 GB，请拆分后上传');
  await fsp.mkdir(directory, { recursive: true });
  const id = randomUUID(), name = safeFilename(path.basename(source)); const localPath = path.join(directory, id + '-' + name);
  const hash = createHash('sha256'); let count = 0;
  await pipeline(fs.createReadStream(source), new Transform({ transform(chunk, _encoding, cb) { hash.update(chunk); count += chunk.length; cb(null, chunk); } }), fs.createWriteStream(localPath, { flags: 'wx' }));
  const after = await fsp.stat(source);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || count !== before.size) { await fsp.rm(localPath, { force: true }); throw new Error('附件在复制期间发生变化，请重新选择：' + name); }
  return { id, name, localPath, sourcePath: source, sha256: hash.digest('hex'), size: count, fetchedAt: new Date().toISOString() };
}
export async function zipEntries(target: string, entries: { name: string; text?: string; file?: string }[]) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const output = fs.createWriteStream(target, { flags: 'wx' });
  const done = pipeline(archive, output);
  for (const entry of entries) {
    if (entry.name.includes('..') || entry.name.startsWith('/') || entry.name.includes('\\')) throw new Error('无效归档路径');
    if (entry.file) archive.file(entry.file, { name: entry.name }); else archive.append(entry.text || '', { name: entry.name });
  }
  await archive.finalize(); await done;
}
export function githubRepository(value: string): string {
  let url: URL; try { url = new URL(value.trim()); } catch { throw new Error('请填写有效的 GitHub 仓库链接'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname) || ['.', '..'].includes(url.pathname.split('/')[2])) throw new Error('请使用 https://github.com/所有者/仓库 格式，不含密码、查询参数或子页面');
  return url.href.replace(/\/$/, '');
}
export async function packageDraft(draft: Draft, root: string): Promise<string> {
  draft = structuredClone(draft);
  const repoUrl = githubRepository(draft.repoUrl || '');
  if (!draft.body.trim()) throw new Error('请填写修改说明');
  const dir = path.join(root, 'packages', randomUUID()); await fsp.mkdir(dir, { recursive: true });
  const entries = [
    { name: 'README.md', text: `# ${draft.title}\n\nGitHub 仓库：${repoUrl}\n\n${draft.body}` },
    { name: 'manifest.json', text: JSON.stringify({ schemaVersion: 2, kind: 'repository-reference', title: draft.title, repoUrl, description: draft.body, createdAt: new Date().toISOString(), sourceSessionId: draft.sessionId, projectId: draft.binding?.project.id }, null, 2) }
  ];
  // Local preparation inputs and legacy attachments are deliberately never included.
  const zip = path.join(dir, safeFilename(draft.title || '成果') + '.zip'); await zipEntries(zip, entries); return zip;
}
export function historyMarkdown(session: AgentSession) {
  return `# ${session.title}\n\n提供方：${session.provider}\n原生会话 ID：${session.nativeId || '尚未创建'}\n项目：${session.binding?.project.name || '本地会话'}\n\n> 这是工作台采集的对话与工具事件，不代表厂商隐藏推理或完整训练轨迹。\n\n` + session.messages.map(m => `## ${m.role} · ${m.createdAt}\n\n${m.text}\n`).join('\n');
}
export async function packageHistory(session: AgentSession, sessionDir: string, root: string) {
  const dir = path.join(root, 'packages', randomUUID()); await fsp.mkdir(dir, { recursive: true });
  const clone = structuredClone(session); clone.approvals = [];
  const entries: { name: string; text?: string; file?: string }[] = [
    { name: 'session.json', text: JSON.stringify({ schemaVersion: 1, captureSource: session.provider === 'codex' ? 'codex-app-server' : 'cursor-acp', trainingConsent: false, capturedAt: new Date().toISOString(), session: clone }, null, 2) },
    { name: 'conversation.md', text: historyMarkdown(clone) }
  ];
  try { entries.push({ name: 'events.jsonl', text: await fsp.readFile(path.join(sessionDir, 'events.jsonl'), 'utf8') }); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  const file = path.join(dir, `session-${session.id}-${Date.now()}.zip`); await zipEntries(file, entries); return file;
}
