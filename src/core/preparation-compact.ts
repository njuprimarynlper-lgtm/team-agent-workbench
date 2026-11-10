import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { AgentSession, Message } from '../shared/types';
import { isPersonalHandoffSource } from '../shared/session-context';
import { codexRolloutStream, existingCodexRollout } from './codex-rollout';
import { codexItem } from './native-transcript';
import type { AgentRpc } from './rpc';

type NativeCompactItem = { type: 'compaction'; encrypted_content: string };
interface CompactRecord {
  at: string;
  text: string;
  native: NativeCompactItem[];
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const statePath = (inputDir: string) => path.join(inputDir, 'preparation-compact.json');

function includesOtherSessionJournal(content: unknown, sessionId: string) {
  if (!Array.isArray(content)) return false;
  return content.some(part => {
    const text = part?.text;
    if (typeof text !== 'string' || !text.includes('[项目会话日志 · ') || !text.includes('摘要只读副本：')) return false;
    const ids = [...text.matchAll(/^### .+ \| (?:codex|cursor|claude) \| ([^\r\n]+)$/gm)];
    return !ids.length || ids.some(match => match[1].trim() !== sessionId);
  });
}

function decodeCompact(at: string, payload: any, sessionId: string): CompactRecord | undefined {
  const native: NativeCompactItem[] = [], passages: string[] = [];
  const summary = typeof payload?.message === 'string' ? payload.message.trim() : '';
  if (summary && !/^(?:context compacted|上下文已压缩)[.!。]?$/i.test(summary)) passages.push(summary);
  const hasSummary = passages.length > 0;
  if (payload?.replacement_history != null && !Array.isArray(payload.replacement_history)) return;
  // Keep retained conversation as evidence in the snapshot, never as executable instructions.
  for (const item of payload?.replacement_history || []) {
    if (item?.type === 'compaction' && typeof item.encrypted_content === 'string' && item.encrypted_content)
      native.push({ type: 'compaction', encrypted_content: item.encrypted_content });
    // Retained tool receipts carry evidence such as exit codes and verification results.
    if (['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(item?.type))
      passages.push(JSON.stringify(item));
    if (item?.type === 'reasoning' && Array.isArray(item.summary))
      for (const part of item.summary) if (typeof part?.text === 'string' && part.text.trim()) passages.push(part.text);
    if (item?.type === 'message' && ['user', 'assistant'].includes(item.role) && Array.isArray(item.content)) {
      if (includesOtherSessionJournal(item.content, sessionId)) return;
      const text = item.content.filter((p: any) => ['input_text', 'output_text', 'text'].includes(p?.type) && typeof p.text === 'string').map((p: any) => p.text).join('\n');
      if (text.trim() && !passages.includes(text)) passages.push(text);
    }
  }
  if (!native.length && !hasSummary) return;
  return { at, text: passages.join('\n\n'), native };
}

/** Freeze the last durable compact before the click. A rollback invalidates earlier candidates. */
export async function preparationCompact(session: AgentSession, captured: Message[], capturedAt: string) {
  if (session.provider !== 'codex' || session.codexRemote || !session.nativeId || !session.nativePath) return;
  const cutoff = Date.parse(capturedAt), expectedId = session.nativeId;
  const file = await existingCodexRollout(session.nativePath);
  const stream = codexRolloutStream(file);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let compact: CompactRecord | undefined, matched = false, hasPrivateContext = false;
  const afterIds = new Set<string>();
  const limitedImport = captured.some(m => m.id === 'native:earlier');
  const importedTail: Message[] = [];
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      // Large tool outputs and reasoning deltas do not participate in checkpoint selection.
      if (!line.includes('"compacted"') && !line.includes('"session_meta"') && !line.includes('"thread_rolled_back"')
        && !line.includes('[项目会话日志') && !(compact && line.includes('"item_completed"'))) continue;
      const row = JSON.parse(line);
      if (row.type === 'session_meta') { if (row.payload?.id !== expectedId) return; matched = true; continue; }
      if (!matched || Date.parse(row.timestamp) > cutoff) continue;
      if (row.type === 'event_msg' && row.payload?.type === 'thread_rolled_back') { compact = undefined; afterIds.clear(); importedTail.length = 0; continue; }
      // Personal cross-session logs are excluded from result preparation. An opaque state
      // containing them cannot be safely redacted, including for imported histories.
      if (row.type === 'response_item' && row.payload?.role === 'user' && includesOtherSessionJournal(row.payload.content, session.id)) hasPrivateContext = true;
      if (row.type === 'compacted') {
        compact = Number.isFinite(Date.parse(row.timestamp)) && !hasPrivateContext ? decodeCompact(row.timestamp, row.payload, session.id) : undefined;
        afterIds.clear(); importedTail.length = 0;
      } else if (compact && row.type === 'event_msg' && row.payload?.item?.id) {
        const id = String(row.payload.item.id);
        if (afterIds.has(id)) continue;
        afterIds.add(id);
        const item = limitedImport && codexItem(row.payload);
        if (item) importedTail.push({ id: 'native:' + id, role: item.role, text: item.text, createdAt: new Date(item.at || Date.parse(row.timestamp) || 0).toISOString() });
      }
    }
  } catch (error: any) {
    // Missing/rotating histories and an unfinished final JSONL record can still use the frozen transcript.
    if (error instanceof SyntaxError || ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return;
    throw error;
  } finally { lines.close(); stream.destroy(); }
  if (!compact) return;
  const at = Date.parse(compact.at);
  const activeReply = ['running', 'approval'].includes(session.status) ? captured.at(-1) : undefined;
  const tail = captured.filter(m => {
    if (m.id === 'native:earlier') return false;
    const time = Date.parse(m.createdAt);
    return !Number.isFinite(time) || time >= at || (m === activeReply && m.role === 'assistant') || afterIds.has(m.nativeItemId || m.id.replace(/^native:/, ''));
  });
  // The desktop import window can contain fewer rows than the post-compact tail.
  // Fill its missing prefix up to the frozen local anchor, keeping local receipts for overlapping rows.
  const anchors = new Set(tail.map(m => m.nativeItemId ? 'native:' + m.nativeItemId : m.id));
  const firstKnown = importedTail.findIndex(m => anchors.has(m.id));
  const prefix = firstKnown > 0 ? importedTail.slice(0, firstKnown) : [];
  const privateSources = new Set(session.sources.filter(isPersonalHandoffSource).map(s => s.id));
  if (captured.some(m => Date.parse(m.createdAt) <= at && (
    Object.keys(m.context?.projectJournal?.sessions || {}).some(id => id !== session.id)
    || Object.keys(m.context?.sourceHashes || {}).some(id => privateSources.has(id))
  ))) return;
  const nativeState = JSON.stringify(compact.native), nativeHash = compact.native.length ? digest(nativeState) : undefined;
  const id = 'compact-' + digest(JSON.stringify([expectedId, compact.at, compact.text, nativeHash]));
  const marker: Message = { id, createdAt: compact.at, role: 'system', text: compact.text || '本条依据为整理会话已加载的 Codex 原生压缩上下文。' };
  return { messages: [marker, ...prefix, ...tail], nativeState, checkpoint: { at: compact.at, nativeHash } };
}

export async function freezePreparationState(inputDir: string, state: string) {
  await fs.writeFile(statePath(inputDir), state, { flag: 'wx', mode: 0o600 });
}

export async function injectPreparationState(rpc: Pick<AgentRpc, 'request'>, threadId: string, inputDir: string, expectedHash: string) {
  const data = await fs.readFile(statePath(inputDir), 'utf8');
  if (digest(data) !== expectedHash) throw Error('冻结的 Codex 压缩状态校验失败，请从来源会话重新整理');
  await rpc.request('thread/inject_items', { threadId, items: JSON.parse(data) });
}
