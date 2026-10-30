import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { AgentRuntime } from '../src/core/agents';
import { CodexSideRpc } from '../src/core/codex-side-rpc';
import type { CodexStorage } from '../src/core/codex-storage';
import type { AgentRpc } from '../src/core/rpc';
import type { AgentSession } from '../src/shared/types';
import { Workbench } from '../src/core/workbench';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

class WriterRpc extends EventEmitter implements AgentRpc {
  readonly calls: { method: string; params: any }[] = [];
  closed = false;
  constructor(private ownsWriter: boolean, private home: string) { super(); }
  async request(method: string, params: any = {}) {
    this.calls.push({ method, params });
    if (method === 'thread/fork') {
      const id = params.threadId === 'parent-native' ? 'child-native' : 'grandchild-native';
      return { thread: { id, path: path.join(this.home, 'sessions', id + '.jsonl') } };
    }
    if (method === 'thread/resume') {
      if (!this.ownsWriter) throw new Error(`thread ${params.threadId} already has an active writer`);
      return { thread: { id: params.threadId, path: path.join(this.home, 'sessions', params.threadId + '.jsonl'), status: { type: 'idle' } }, modelProvider: params.config?.model_provider, approvalPolicy: 'never', sandbox: { type: 'externalSandbox' } };
    }
    if (method === 'turn/start') return { turn: { id: 'child-turn' } };
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    throw new Error('unexpected RPC: ' + method);
  }
  notify() {}
  respond() {}
  reject() {}
  async close() { this.closed = true; this.emit('closed', new Error('closed')); }
}

test('a native child resumes and sends through the fork writer, without starting another app-server', async () => {
  const home = path.resolve('writer-fixture-home');
  const storage: CodexStorage = { home, sourceHome: home, args: ['app-server'], env: {} };
  const rpc = new WriterRpc(true, home);
  const parent = { id: 'parent', provider: 'codex', purpose: 'work', cwd: home, nativeId: 'parent-native', status: 'idle', messages: [], approvals: [] } as unknown as AgentSession;
  const hooks = { changed() {}, event() {}, done() {} };
  const parentRuntime = new AgentRuntime(parent, 'unused', hooks, storage, {}, rpc);
  (parentRuntime as any).initialized = true;
  (parentRuntime as any).codexConnected = true;
  let guardClosed = false;
  let authClosed = false, refreshes = 0;
  (parentRuntime as any).guardConfig = { model_provider: 'guard-fixture' };
  (parentRuntime as any).requestGuard = { observeRequests: () => () => {}, close: async () => { guardClosed = true; } };
  (parentRuntime as any).authBridge = { close: async () => { authClosed = true; }, refresh: async () => { refreshes++; } };
  let childRuntime: AgentRuntime | undefined;
  let grandchildRuntime: AgentRuntime | undefined;
  try {
    const fork = await parentRuntime.forkCodexThread();
    const child = { ...parent, id: 'child', nativeId: fork.id, nativePath: fork.path, codexStorage: 'workbench',
      fork: { parentId: parent.id, nativeFork: true }, messages: [], approvals: [] } as unknown as AgentSession;
    childRuntime = parentRuntime.borrowForkRuntime(child, 'unused', hooks, storage);
    assert(childRuntime);
    assert(childRuntime.rpc instanceof CodexSideRpc);
    assert.equal(childRuntime.rpc.owner, rpc);
    assert.equal(await childRuntime.prompt('首次发送'), true);
    assert.equal(rpc.calls.find(call => call.method === 'thread/resume')!.params.config.model_provider, 'guard-fixture');
    assert.deepEqual(rpc.calls.filter(call => ['thread/fork', 'thread/resume', 'turn/start'].includes(call.method)).map(call => [call.method, call.params.threadId]), [
      ['thread/fork', 'parent-native'], ['thread/resume', 'child-native'], ['turn/start', 'child-native'],
    ]);
    assert.equal(parent.status, 'idle');
    rpc.emit('message', { method: 'item/agentMessage/delta', params: { threadId: 'child-native', itemId: 'reply', delta: '子会话回复' } });
    assert.equal(child.messages.at(-1)?.text, '子会话回复');
    assert.equal(parent.messages.length, 0);
    rpc.emit('message', { method: 'turn/completed', params: { threadId: 'child-native', turn: { id: 'child-turn', status: 'completed' } } });
    await parentRuntime.close();
    assert.equal(rpc.closed, false, 'closing the parent retains the writer while its child is open');
    assert.equal(guardClosed, false, 'the child must keep the request guard alive');
    assert.equal(authClosed, false, 'the child must retain token refresh');
    rpc.emit('message', { method: 'account/chatgptAuthTokens/refresh', id: 99 });
    assert.equal(refreshes, 1, 'the closed parent still services shared authentication');
    assert.equal(await childRuntime.prompt('父会话关闭后继续'), true);
    rpc.emit('message', { method: 'turn/completed', params: { threadId: 'child-native', turn: { id: 'child-turn', status: 'completed' } } });
    const grandFork = await childRuntime.forkCodexThread();
    const grandchild = { ...child, id: 'grandchild', nativeId: grandFork.id, nativePath: grandFork.path,
      fork: { parentId: child.id, nativeFork: true }, messages: [], approvals: [], status: 'idle' } as unknown as AgentSession;
    grandchildRuntime = childRuntime.borrowForkRuntime(grandchild, 'unused', hooks, storage);
    assert(grandchildRuntime?.rpc instanceof CodexSideRpc);
    assert.equal(grandchildRuntime.rpc.owner, rpc, 'nested forks route directly through the original writer');
    await childRuntime.close(); childRuntime = undefined;
    assert.equal(rpc.closed, false, 'the grandchild keeps the writer after its parent closes');
    assert.equal(await grandchildRuntime.prompt('第二层首次发送'), true);
    await grandchildRuntime.close(); grandchildRuntime = undefined;
    assert.equal(rpc.closed, true, 'the app-server closes when its final borrower closes');
    assert.equal(guardClosed, true, 'the final borrower releases the request guard');
    assert.equal(authClosed, true);
    assert.equal(rpc.calls.at(-1)?.method, 'thread/unsubscribe');
  } finally { await grandchildRuntime?.close(); await childRuntime?.close(); await parentRuntime.close(); }
});

test('an external writer conflict leaves the child unsent with a recovery hint', async () => {
  const home = path.resolve('writer-fixture-home');
  const storage: CodexStorage = { home, sourceHome: home, args: ['app-server'], env: {} };
  const rpc = new WriterRpc(false, home);
  const child = { id: 'child', provider: 'codex', purpose: 'work', cwd: home, nativeId: 'child-native',
    codexStorage: 'workbench', fork: { parentId: 'parent', nativeFork: true }, status: 'idle', messages: [], approvals: [] } as unknown as AgentSession;
  const runtime = new AgentRuntime(child, 'unused', { changed() {}, event() {}, done() {} }, storage, {}, rpc, true);
  try {
    await assert.rejects(runtime.ensureStarted(), /另一个 Codex 后台占用.*重新发送/);
    assert.equal(child.status, 'error');
    assert.equal(child.messages.length, 0);
    assert.equal(rpc.calls.some(call => call.method === 'turn/start'), false);
    assert.equal(rpc.closed, true);
  } finally { await runtime.close(); }
});

test('Workbench routes the first send of a persisted native fork to its parent app-server', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-fork-writer-'));
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    wb.store.settings.providerPaths.codex = path.resolve('tests/fixtures/rpc-agent.mjs');
    const parent = await wb.createSession('codex', root, offlineProjectId);
    parent.nativeId = 'parent-native'; parent.codexStorage = 'workbench';
    const home = path.join(wb.store.root, 'codex-home');
    const rpc = new WriterRpc(true, home);
    const storage: CodexStorage = { home, sourceHome: home, args: ['app-server'], env: {} };
    const parentRuntime = new AgentRuntime(parent, 'unused', { changed() {}, event() {}, done() {} }, storage, {}, rpc);
    (parentRuntime as any).initialized = true;
    (parentRuntime as any).codexConnected = true;
    (wb as any).runtimes.set(parent.id, parentRuntime);
    const child = await wb.forkSubsession(parent.id, '验证首次发送');
    const childRuntime = await (wb as any).runtime(child) as AgentRuntime;
    assert(childRuntime.rpc instanceof CodexSideRpc, 'the child must not spawn a second app-server');
    assert.equal(childRuntime.rpc.owner, rpc);
    assert.equal(await childRuntime.prompt('开始'), true);
    assert.equal(rpc.calls.find(call => call.method === 'turn/start')?.params.threadId, child.nativeId);
    assert.equal(child.messages.find(message => message.role === 'user')?.text, '开始');
    rpc.emit('message', { method: 'turn/completed', params: { threadId: child.nativeId, turn: { id: 'child-turn', status: 'completed' } } });
    const grandchild = await wb.forkSubsession(child.id, '第二层');
    await wb.closeSession(child.id);
    const grandchildRuntime = await (wb as any).runtime(grandchild) as AgentRuntime;
    assert(grandchildRuntime.rpc instanceof CodexSideRpc);
    assert.equal(grandchildRuntime.rpc.owner, rpc, 'a grandchild can find the original writer after its direct parent closes');
    assert.equal(await grandchildRuntime.prompt('第二层开始'), true);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});
