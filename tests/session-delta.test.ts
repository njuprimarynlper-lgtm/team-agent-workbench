import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession, Snapshot } from '../src/shared/types';
import { applySessionDelta, applySideChatDelta, mergeNewerSessions } from '../src/renderer/session-delta';

const session = (revision: number, text: string): AgentSession => ({
  id: '11111111-1111-4111-8111-111111111111', title: '会话', provider: 'codex', purpose: 'work', status: 'running',
  createdAt: '2026-01-01T00:00:00.000Z', cwd: '', handoffPath: '', sources: [], approvals: [], autoUpload: false,
  storageRevision: revision, messages: [{ id: 'message', role: 'assistant', text, createdAt: '2026-01-01T00:00:00.000Z' }],
});
const snapshot = (value: AgentSession) => ({ sessions: [value] }) as Snapshot;

test('a late full snapshot cannot replace newer streamed content', () => {
  const current = snapshot(session(3, '最新输出'));
  const stale = snapshot(session(2, '旧输出'));
  assert.equal(mergeNewerSessions(stale, current).sessions[0].messages[0].text, '最新输出');
  assert.equal(mergeNewerSessions(snapshot(session(4, '完成')), current).sessions[0].messages[0].text, '完成');
});

test('a session delta replaces one message and adds a new one', () => {
  const current = snapshot(session(1, '第一段'));
  const sources = [{ id: 'visible', name: '已筛选的参考文件' }] as AgentSession['sources'];
  current.sessions[0].sources = sources;
  const next = session(2, '第一段，第二段');
  next.messages.push({ id: 'tool', role: 'tool', text: '执行完成', createdAt: next.createdAt });
  const { messages, sources: _sources, ...metadata } = next;
  const result = applySessionDelta(current, { type: 'session-delta', session: metadata, messages });
  assert.deepEqual(result?.sessions[0].messages.map(message => message.text), ['第一段，第二段', '执行完成']);
  assert.equal(result?.sessions[0].sources, sources);
  assert.equal(applySessionDelta(result, { type: 'session-delta', session: { ...metadata, storageRevision: 1 }, messages: [current.sessions[0].messages[0]] }), result);
});

test('side chat output updates without replacing the parent conversation', () => {
  const parent = session(1, '父会话');
  const chatSession = { ...session(1, '侧聊第一段'), id: '22222222-2222-4222-8222-222222222222' };
  const chat = { id: 'chat', parentId: parent.id, projectId: 'project', parentTitle: parent.title, capturedAt: parent.createdAt, draft: '', session: chatSession };
  const current = { ...snapshot(parent), sideChats: [chat] };
  const next = { ...session(2, '侧聊第二段'), id: chatSession.id };
  const { messages, sources: _sources, ...metadata } = next;
  const updated = applySideChatDelta(current, { type: 'sidechat-delta', chatId: chat.id, session: metadata, messages });
  assert.equal(updated?.sideChats?.[0].session.messages[0].text, '侧聊第二段');
  assert.equal(updated?.sessions[0], parent);
  assert.equal(mergeNewerSessions(current, updated).sideChats?.[0].session.messages[0].text, '侧聊第二段');
});

test('streaming after a paged snapshot evicts old tail messages and advances the total', () => {
  const current = snapshot(session(1, 'old'));
  current.sessions[0].messages = Array.from({ length: 160 }, (_, index) => ({ ...current.sessions[0].messages[0], id: `m${index}` }));
  current.sessions[0].messageCount = 700;
  current.sessions[0].historyToken = 'before';
  const incoming = { ...current.sessions[0].messages[0], id: 'new', text: 'latest' };
  const result = applySessionDelta(current, { type: 'session-delta', session: { id: current.sessions[0].id, storageRevision: 2, messageCount: 701 } as AgentSession, messages: [incoming] })!;
  assert.equal(result.sessions[0].messages.length, 160);
  assert.equal(result.sessions[0].messages[0].id, 'm1');
  assert.equal(result.sessions[0].messages.at(-1)?.id, 'new');
  assert.equal(result.sessions[0].messageCount, 701);
  assert.equal(result.sessions[0].historyToken, undefined);
});
