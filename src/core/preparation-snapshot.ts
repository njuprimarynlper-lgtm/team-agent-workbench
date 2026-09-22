import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentSession, PreparationScope, SourceFile } from '../shared/types';
import { atomicJson } from './store';
import { freezeFile } from './artifacts';
import { mentionedFiles } from './session-files';
import { preparationDelta } from '../shared/preparation-progress';

interface PreparationSnapshotOptions {
  scope?: PreparationScope;
  baseDraftId?: string;
  baseLastMessageId?: string;
  baseCapturedAt?: string;
  baseMessageCount?: number;
  baseLastMessageLength?: number;
}

// Capture messages before the first await: ongoing work must not change this input.
export async function preparationSnapshot(session: AgentSession, inputDir: string, extraFiles: string[] = [], options: PreparationSnapshotOptions = {}) {
  const allMessages = structuredClone(session.messages), capturedAt = new Date().toISOString(), scope = options.scope || 'full';
  let messages = allMessages;
  if (scope === 'incremental') {
    const delta = preparationDelta({ messages: allMessages }, { capturedAt: options.baseCapturedAt || '', conversationHash: '', messageCount: options.baseMessageCount ?? -1, lastMessageId: options.baseLastMessageId, lastMessageLength: options.baseLastMessageLength });
    if (!delta.count) throw new Error(delta.reason);
    messages = allMessages.slice(delta.start);
  }
  const conversation = messages.map(m => ({ id: m.id, role: m.role, text: m.text, createdAt: m.createdAt }));
  const conversationHash = createHash('sha256').update(JSON.stringify(conversation)).digest('hex');
  await fs.mkdir(inputDir, { recursive: true });
  await atomicJson(path.join(inputDir, 'conversation.json'), conversation);
  let handoff: SourceFile | undefined, noteWarning: string | undefined;
  try { handoff = await freezeFile(session.handoffPath, inputDir); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; noteWarning = '阶段摘要缺失；依据冻结对话整理。'; }
  const files: SourceFile[] = [];
  for (const source of session.sources) { const copy = await freezeFile(source.localPath, inputDir); files.push({ ...copy, name: source.name, sourcePath: source.sourcePath }); }
  for (const file of extraFiles) files.push(await freezeFile(file, inputDir));
  // Only known files inside this session's workspace become candidates. Never crawl a directory.
  const canonical = session.cwd ? await fs.realpath(session.cwd).catch(() => '') : '';
  for (const candidate of canonical ? mentionedFiles(session).slice(-100) : []) {
    const relative = path.relative(session.cwd, candidate);
    if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some(part => part.startsWith('.')) || /(?:^|[/\\])(?:node_modules|credentials|secrets)(?:[/\\]|$)/i.test(relative) || /\.(?:pem|key|pfx|p12)$/i.test(relative) || files.some(file => file.sourcePath === candidate)) continue;
    try {
      const actual = await fs.realpath(candidate), inside = path.relative(canonical, actual), stat = await fs.lstat(candidate);
      if (path.isAbsolute(inside) || inside.startsWith('..') || !stat.isFile() || stat.size > 10 * 1024 * 1024 || files.length >= 30) continue;
      files.push(await freezeFile(candidate, inputDir));
    } catch { /* Missing or changing outputs can be added manually after preparation. */ }
  }
  const snapshot = { capturedAt, messageCount: messages.length, totalMessageCount: allMessages.length, lastMessageId: allMessages.at(-1)?.id, lastMessageLength: allMessages.at(-1)?.text.length, conversationHash, scope, baseDraftId: options.baseDraftId, baseLastMessageId: options.baseLastMessageId, baseCapturedAt: options.baseCapturedAt };
  await atomicJson(path.join(inputDir, 'source-index.json'), { sourceSessionId: session.id, ...snapshot, conversation: 'conversation.json', handoff, noteWarning, files });
  return { files, snapshot };
}
