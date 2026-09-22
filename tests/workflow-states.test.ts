import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { TransferQueue } from '../src/core/transfers';
import type { SharedFiles } from '../src/core/shared-files';
import type { Draft, RemoteBinding } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Shared fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

const until = async (fn: () => boolean) => { const end = Date.now() + 15000; while (!fn()) { if (Date.now() > end) throw new Error('state transition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const cleanup = async (root: string) => { assert(root.startsWith(path.join(os.tmpdir(), 'wb-state-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };

for (const provider of ['codex', 'cursor'] as const) test(provider + ': stop during authentication never sends later, running stop preserves history and can resume', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-state-stop-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'hang' });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths[provider] = fixture.launcher;
    const s = await wb.createSession(provider, root, offlineProjectId), wait = gate(), original = wb.requireAuth.bind(wb);
    await wb.saveInput(s.id, { text: '保留未发送的问题', sourceIds: [], answers: {} });
    wb.requireAuth = async () => { await wait.promise; };
    const pending = wb.send(s.id, '保留未发送的问题'); await until(() => s.status === 'starting');
    await wb.stop(s.id); wait.release(); assert.equal(await pending, false);
    assert.equal(s.status, 'idle'); assert(s.stoppedAt); assert.equal(s.messages.length, 0); assert.equal(s.nativeId, undefined);
    assert.equal(wb.store.inputs[s.id].text, '保留未发送的问题');
    wb.requireAuth = original;
    const running = wb.send(s.id, '长任务'); await until(() => s.status === 'running');
    const nativeId = s.nativeId; await wb.stop(s.id); await running;
    assert.equal(s.status, 'idle'); assert(s.stoppedAt); assert.equal(s.approvals.length, 0); assert.equal(s.nativeId, nativeId);
    await fixture.write({ status: 'ready', turn: 'success' }); await wb.send(s.id, '继续'); await until(() => s.status === 'idle');
    assert.equal(s.stoppedAt, undefined); assert.equal(s.nativeId, nativeId); assert.equal(s.messages.filter(m => m.role === 'user').length, 2);
    await wb.closeSession(s.id); await assert.rejects(wb.changePermissions(s.id, 'inherit'), /已关闭/);
    await assert.rejects(wb.refreshProjectContext(s.id), /未关闭/);
  } finally { await wb.close(); await cleanup(root); }
});

test('restart preserves errors and stopped states and identifies unfinished work instead of marking it ready', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-state-restart-'));
  try {
    const sessions = ['idle', 'starting', 'running', 'approval', 'error'].map((status, index) => ({ id: randomUUID(), status, sources: [], messages: [], approvals: [{ id: 'old' }], error: status === 'error' ? '原始失败原因' : undefined, title: String(index) }));
    sessions.push({ ...sessions[2], id: randomUUID(), stoppedAt: '2026-09-21T00:00:00Z' } as any);
    await fs.writeFile(path.join(root, 'sessions.json'), JSON.stringify(sessions));
    const store = new Store(root); await store.init();
    assert.equal(store.sessions[0].status, 'idle');
    for (const s of store.sessions.slice(1, 4)) { assert.equal(s.status, 'error'); assert.match(s.error!, /中断/); assert.deepEqual(s.approvals, []); }
    assert.equal(store.sessions[4].error, '原始失败原因'); assert.equal(store.sessions[4].status, 'error');
    assert.equal(store.sessions[5].status, 'idle'); assert(store.sessions[5].stoppedAt);
  } finally { await cleanup(root); }
});

test('normal application shutdown records an interrupted work session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-state-shutdown-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'hang' });
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const s = await wb.createSession('codex', root, offlineProjectId); await wb.send(s.id, '尚未完成'); await until(() => s.status === 'running');
    await wb.close(); const restored = new Store(wb.store.root); await restored.init();
    assert.equal(restored.sessions[0].status, 'error'); assert.match(restored.sessions[0].error!, /中断/); assert.equal(restored.sessions[0].nativeId, s.nativeId);
  } finally { await wb.close(); await cleanup(root); }
});

test('deleting a running preparation excludes retries and removes helper attempts; saved records can also be deleted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-state-delete-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const parent = await wb.createSession('codex', root, offlineProjectId), id = randomUUID(), base = path.join(wb.store.root, 'drafts', id);
    await fs.mkdir(path.join(base, 'attempt'), { recursive: true });
    const first = await wb.createSession('codex', base, undefined, 'prepare', parent.id), last = await wb.createSession('codex', path.join(base, 'attempt'), undefined, 'prepare', parent.id);
    const draft = { id, sessionId: parent.id, prepareSessionId: last.id, generation: 'running', title: '删除边界', body: '', files: [], inputDir: path.join(base, 'input'), outputPath: path.join(base, 'draft.md'), createdAt: '' } as Draft;
    wb.store.drafts.push(draft);
    const save = wb.store.save.bind(wb.store), saving = gate(), release = gate(); let held = false;
    wb.store.save = async () => { if (!held) { held = true; saving.release(); await release.promise; } await save(); };
    const deleting = wb.deleteDraft(id); await saving.promise;
    await assert.rejects(wb.retryPreparation(id), /正在删除/); await assert.rejects(wb.deleteDraft(id), /正在删除/);
    release.release(); await deleting;
    assert(!wb.store.sessions.some(s => [first.id, last.id].includes(s.id))); assert(wb.store.sessions.some(s => s.id === parent.id));
    const saved = { ...draft, id: randomUUID(), generation: 'ready', mergeCompletedAt: new Date().toISOString() } as Draft; wb.store.drafts.push(saved);
    await assert.rejects(wb.retryPreparation(saved.id), /已提交/); await wb.deleteDraft(saved.id); assert(!wb.store.drafts.includes(saved));
  } finally { await wb.close(); await cleanup(root); }
});

const binding: RemoteBinding = { connectionId: 'test', host: 'local', port: 22, username: 'alice', fingerprint: 'test', project: { id: 'p', name: 'P', remoteRoot: '/p', uploadPath: '/p/uploads', historyPath: '/p/history' } };
for (const failure of ['enqueue', 'running', 'completed'] as const) test('transfer persistence failure at ' + failure + ' remains retryable and never leaves a running queue stuck', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-state-transfer-')), store = new Store(root);
  try {
    await store.init(); const file = path.join(root, 'source.txt'); await fs.writeFile(file, 'payload');
    let uploads = 0, writes = 0; const targets: string[] = [], byteStates: number[] = [];
    const remote = { channel: () => {}, ensurePersonalFolder: async () => {}, upload: async (_binding: RemoteBinding, _local: string, target: string, progress: (bytes: number, total: number) => void) => { uploads++; targets.push(target); progress(7, 7); } } as unknown as SharedFiles;
    const queue = new TransferQueue(store, remote, () => { if (store.transfers[0]?.status === 'queued') byteStates.push(store.transfers[0].bytes); });
    const save = store.save.bind(store); store.save = async () => { if (++writes === ({ enqueue: 1, running: 2, completed: 3 })[failure]) throw new Error('fixture disk unavailable'); await save(); };
    if (failure === 'enqueue') { await assert.rejects(queue.enqueue(file, binding, '/p/uploads', 'upload'), /disk/); assert.equal(uploads, 0); assert.equal(store.transfers.length, 0); }
    else {
      const item = await queue.enqueue(file, binding, '/p/uploads', 'upload'); await until(() => item.status === 'error' && !(queue as any).active);
      assert.match(item.error!, /disk/); assert.equal(uploads, failure === 'running' ? 0 : 1);
      await queue.retry(item.id); await until(() => item.status === 'done' && !(queue as any).active);
      assert(byteStates.every(bytes => bytes === 0)); assert.equal(new Set(targets).size, 1); assert.equal(store.transfers.length, 1);
      await assert.rejects(queue.retry(item.id), /只能重试/);
    }
    await queue.enqueue(file, binding, '/p/uploads', 'upload'); await until(() => store.transfers[0].status === 'done' && !(queue as any).active);
  } finally { await cleanup(root); }
});
