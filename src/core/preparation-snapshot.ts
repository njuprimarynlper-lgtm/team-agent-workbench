import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentSession, SourceFile } from '../shared/types';
import { atomicJson } from './store';
import { freezeFile } from './artifacts';

// Capture messages before the first await: ongoing work must not change this input.
export async function preparationSnapshot(session: AgentSession, inputDir: string, extraFiles: string[] = []) {
  const messages = structuredClone(session.messages), capturedAt = new Date().toISOString();
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
  const snapshot = { capturedAt, messageCount: messages.length, lastMessageId: messages.at(-1)?.id, conversationHash };
  await atomicJson(path.join(inputDir, 'source-index.json'), { sourceSessionId: session.id, ...snapshot, conversation: 'conversation.json', handoff, noteWarning, files });
  return { files, snapshot };
}
