import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentSession, PreparationScope, SourceFile } from '../shared/types';
import { atomicJson } from './store';
import { freezeFile } from './artifacts';

interface PreparationSnapshotOptions {
  scope?: PreparationScope;
  baseDraftId?: string;
  baseLastMessageId?: string;
  baseCapturedAt?: string;
  baseMessageCount?: number;
}

// Capture messages before the first await: ongoing work must not change this input.
export async function preparationSnapshot(session: AgentSession, inputDir: string, extraFiles: string[] = [], options: PreparationSnapshotOptions = {}) {
  const allMessages = structuredClone(session.messages), capturedAt = new Date().toISOString(), scope = options.scope || 'full';
  let messages = allMessages;
  if (scope === 'incremental') {
    let start = -1;
    if (options.baseLastMessageId) start = allMessages.findIndex(message => message.id === options.baseLastMessageId);
    else if (options.baseMessageCount === 0) start = -1;
    else throw new Error('上次整理缺少可定位的消息快照，请改用全量整理');
    if (options.baseLastMessageId && start < 0) throw new Error('无法在当前会话中定位上次整理位置，请改用全量整理');
    messages = allMessages.slice(start + 1);
    if (!messages.length) throw new Error('上次整理后没有新增消息，无需增量整理');
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
  const snapshot = { capturedAt, messageCount: messages.length, totalMessageCount: allMessages.length, lastMessageId: allMessages.at(-1)?.id, conversationHash, scope, baseDraftId: options.baseDraftId, baseLastMessageId: options.baseLastMessageId, baseCapturedAt: options.baseCapturedAt };
  await atomicJson(path.join(inputDir, 'source-index.json'), { sourceSessionId: session.id, ...snapshot, conversation: 'conversation.json', handoff, noteWarning, files });
  return { files, snapshot };
}
