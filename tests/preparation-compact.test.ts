import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { Workbench } from '../src/core/workbench';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Test-only local protocol fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';
import { preparationCompact, injectPreparationState } from '../src/core/preparation-compact';
import { preparationSnapshot, prepareReadableInputs } from '../src/core/preparation-snapshot';
import { preparationDelta } from '../src/shared/preparation-progress';
import type { AgentSession, Message } from '../src/shared/types';

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const message = (id: string, text: string, second: number): Message => ({ id, role: 'assistant', text, createdAt: at(second) });
const meta = { type: 'session_meta', payload: { id: 'parent' } };
const compact = (second: number, text: string, state?: string) => ({ timestamp: at(second), type: 'compacted', payload: {
  message: text, replacement_history: state ? [{ type: 'compaction', encrypted_content: state }] : [],
} });

async function fixture(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prep-compact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nativePath = path.join(root, 'rollout.jsonl');
  const session: AgentSession = { id: 'source', title: '长会话', purpose: 'work', status: 'idle', createdAt: at(0), approvals: [], autoUpload: false, provider: 'codex', nativeId: 'parent', nativePath, cwd: root, handoffPath: path.join(root, 'handoff.md'), sources: [],
    messages: [message('old', 'TOOL_OUTPUT'.repeat(100_000), 1), message('new', '压缩后修正了结论', 5)] };
  const history = async (...rows: object[]) => fs.writeFile(nativePath + '.zst', zstdCompressSync(Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n')));
  return { root, session, history, input: path.join(root, 'draft', 'input') };
}

test('full preparation freezes the latest compact and tail; the original transcript still owns incremental progress', async t => {
  const f = await fixture(t);
  await f.history(meta, compact(2, '已淘汰的摘要'), compact(3, '最后一次摘要', 'CIPHER'));
  const { snapshot } = await preparationSnapshot(f.session, f.input);
  const { conversation } = await prepareReadableInputs(f.input);
  assert.deepEqual(conversation.map((m: Message) => m.text), ['最后一次摘要', '压缩后修正了结论']);
  assert.equal(snapshot.lastMessageId, 'new'); assert.equal(snapshot.lastMessageLength, f.session.messages[1].text.length);
  assert.equal(snapshot.totalMessageCount, 2); assert.equal(snapshot.messageCount, 2);
  assert.equal(preparationDelta(f.session, snapshot).count, 0);
  assert.ok(!JSON.stringify(conversation).includes('CIPHER'));
  // A later compact on the parent must not change what a retry loads into its new helper.
  await f.history(meta, compact(6, '更晚', 'OTHER'));
  const calls: any[] = [];
  const rpc = { request: async (method: string, params: unknown) => { calls.push({ method, params }); } };
  await injectPreparationState(rpc, 'helper', f.input, snapshot.compact!.nativeHash!);
  assert.deepEqual(calls, [{ method: 'thread/inject_items', params: { threadId: 'helper', items: [{ type: 'compaction', encrypted_content: 'CIPHER' }] } }]);
  await fs.writeFile(path.join(f.input, 'preparation-compact.json'), '[]');
  await assert.rejects(injectPreparationState(rpc, 'helper', f.input, snapshot.compact!.nativeHash!), /校验/);
  assert.equal(calls.length, 1);
  await preparationSnapshot(f.session, path.join(f.root, 'next', 'input'), [], { scope: 'incremental', baseLastMessageId: 'old', baseLastMessageLength: f.session.messages[0].text.length });
  const next = await prepareReadableInputs(path.join(f.root, 'next', 'input'));
  assert.deepEqual(next.conversation.map((m: Message) => m.id), ['new']);
});

test('the workbench seeds only the new preparation thread before submitting its task', async t => {
  const f = await fixture(t), wb = new Workbench(path.join(f.root, 'data'), () => {}, () => {});
  try {
    const cli = path.join(f.root, 'cli'), launcher = await authLauncher(cli, { status: 'ready', turn: 'success' });
    await wb.store.init(); grantTestWorkspace(wb, f.root);
    wb.store.settings.providerPaths.codex = launcher.launcher; wb.store.settings.codexRequestGuard = false;
    const parent = await wb.createSession('codex', f.root, offlineProjectId);
    Object.assign(parent, { nativeId: 'parent', nativePath: f.session.nativePath, messages: f.session.messages });
    await f.history(meta, compact(3, '', 'NATIVE_STATE'));
    const draft = await wb.prepare(parent.id, [], ['todo'], 'full'), deadline = Date.now() + 15000;
    while (draft.generation === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(draft.generation, 'ready', draft.generationError || '整理任务未完成');
    const calls = (await fs.readFile(path.join(cli, 'rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const seeded = calls.findIndex(call => call.method === 'thread/inject_items');
    assert.ok(seeded >= 0 && seeded < calls.findIndex(call => call.method === 'turn/start'));
    assert.deepEqual(calls[seeded].params, { threadId: wb.session(draft.prepareSessionId!).nativeId, items: [{ type: 'compaction', encrypted_content: 'NATIVE_STATE' }] });
    assert.ok(!calls.some(call => call.params?.threadId === 'parent' || call.method === 'thread/compact/start'));
  } finally { await wb.close(); }
});

test('a capped desktop transcript includes native tail rows preceding the first visible item', async t => {
  const f = await fixture(t);
  const event = (id: string, text: string, sec: number) => ({ type: 'event_msg', timestamp: at(sec),
    payload: { type: 'item_completed', completed_at_ms: Date.parse(at(sec)), item: { type: 'AgentMessage', id, content: [{ type: 'text', text }] } } });
  await f.history(meta, compact(2, '阶段结论'), event('before-window', '压缩之后但在窗口外', 3), event('visible', '可见内容', 4));
  f.session.messages = [message('native:earlier', '更早的对话', 0), message('native:visible', '完整的本地可见内容', 4)];
  const result = await preparationCompact(f.session, f.session.messages, at(8));
  assert.deepEqual(result?.messages.map(m => m.text), ['阶段结论', '压缩之后但在窗口外', '完整的本地可见内容']);
});

test('uses a native-only state, excludes future and rolled-back checkpoints, and never crosses thread or journal ownership', async t => {
  const f = await fixture(t);
  const read = () => preparationCompact(f.session, f.session.messages, at(8));
  await f.history(meta, compact(3, '', 'OPAQUE'), compact(9, 'future'));
  assert.ok((await read())?.checkpoint.nativeHash);
  await f.history(meta, compact(3, 'old'), { type: 'event_msg', timestamp: at(4), payload: { type: 'thread_rolled_back' } });
  assert.equal(await read(), undefined);
  await f.history({ type: 'session_meta', payload: { id: 'wrong-thread' } }, compact(3, 'wrong'));
  assert.equal(await read(), undefined);
  const journal = { type: 'response_item', timestamp: at(2), payload: { role: 'user', content: [{ text: '[项目会话日志 · 首次全量]\n### private | codex | someone-else\n摘要只读副本：private.md' }] } };
  await f.history(meta, journal, compact(3, '', 'PRIVATE'));
  assert.equal(await read(), undefined);
  await f.history(meta, compact(3, 'earlier'), compact(4, ''));
  assert.equal(await read(), undefined);
});
