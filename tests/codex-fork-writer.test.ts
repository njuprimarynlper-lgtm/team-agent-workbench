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
import { Store } from '../src/core/store';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

class WriterRpc extends EventEmitter implements AgentRpc {
  readonly calls: { method: string; params: any }[] = [];
  closed = false;
  closeCount = 0;
  holdClose?: Promise<void>;
  resumeStatus = 'idle';
  configuredEffort?: string;
  constructor(private ownsWriter: boolean, private home: string) { super(); }
  async request(method: string, params: any = {}) {
    this.calls.push({ method, params });
    if (method === 'thread/fork') {
      const id = params.threadId === 'parent-native' ? 'child-native' : 'grandchild-native';
      return { thread: { id, path: path.join(this.home, 'sessions', id + '.jsonl') } };
    }
    if (method === 'thread/resume') {
      if (!this.ownsWriter) throw new Error(`thread ${params.threadId} already has an active writer`);
      return { thread: { id: params.threadId, path: path.join(this.home, 'sessions', params.threadId + '.jsonl'), status: { type: this.resumeStatus } }, model: params.model, reasoningEffort: params.config?.model_reasoning_effort, modelProvider: params.config?.model_provider, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: params.sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'externalSandbox' } };
    }
    if (method === 'turn/start') return { turn: { id: params.threadId === 'parent-native' ? 'root-turn' : 'child-turn', status: 'inProgress' } };
    if (method === 'turn/interrupt') {
      this.emit('message', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } } });
      return {};
    }
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    if (method === 'command/exec') return { exitCode: 0, stdout: 'WORKBENCH_PERMISSION_OK' };
    if (method === 'config/read') return { config: { model_reasoning_effort: this.configuredEffort } };
    if (method === 'model/list') return { data: [{ model: 'first-model', defaultReasoningEffort: 'medium' }] };
    if (method === 'collaborationMode/list') return { data: [{ mode: 'plan', model: 'first-model' }] };
    throw new Error('unexpected RPC: ' + method);
  }
  notify() {}
  respond() {}
  reject() {}
  async close() { if (this.closed) return; this.closed = true; this.closeCount++; this.emit('closed', new Error('closed')); await this.holdClose; }
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
  (parentRuntime as any).requestGuard = { beforeUpload: () => () => {}, observeRequests: () => () => {}, close: async () => { guardClosed = true; } };
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

async function retainedWriter(run: (f: { wb: Workbench; parent: AgentSession; child: AgentSession; owner: AgentRuntime; childRuntime: AgentRuntime; rpc: WriterRpc }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-retained-writer-'));
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    wb.store.settings.providerPaths.codex = path.resolve('tests/fixtures/rpc-agent.mjs');
    wb.store.settings.codexRequestGuard = false;
    // All model traffic uses the in-memory protocol fixture, without personal login.
    (wb as any).requireAuth = async () => {};
    const parent = await wb.createSession('codex', root, offlineProjectId, 'work', undefined, 'first-model', 'inherit', false, 'direct');
    parent.reasoningEffort = 'high';
    parent.nativeId = 'parent-native'; parent.codexStorage = 'workbench';
    const home = path.join(wb.store.root, 'codex-home'), rpc = new WriterRpc(true, home);
    const owner = new AgentRuntime(parent, 'unused', { changed() {}, event() {}, done() {} }, { home, sourceHome: home, args: ['app-server'], env: {} }, {}, rpc);
    Object.assign(owner, { initialized: true, codexConnected: true }); (wb as any).runtimes.set(parent.id, owner);
    rpc.on('closed', () => { if ((wb as any).runtimes.get(parent.id) === owner) (wb as any).runtimes.delete(parent.id); });
    const child = await wb.forkSubsession(parent.id, '保持打开的子会话');
    const childRuntime = await (wb as any).runtime(child) as AgentRuntime;
    await run({ wb, parent, child, owner, childRuntime, rpc });
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
}

for (const closeFirst of ['root', 'child'] as const) test(`stopped root resumes through the retained writer while its child runs; close ${closeFirst} first`, () => retainedWriter(async ({ wb, parent, child, rpc }) => {
  assert.equal(await wb.send(parent.id, '停止前的根任务'), true);
  assert.equal(await wb.send(child.id, '持续运行的子任务'), true);
  await wb.stop(parent.id);
  assert.equal(rpc.closed, false); assert.equal(child.status, 'running');
  assert(rpc.calls.filter(call => call.method === 'turn/interrupt').every(call => call.params.threadId === parent.nativeId));
  const [a, b] = await Promise.all([(wb as any).runtime(parent), (wb as any).runtime(parent)]) as AgentRuntime[];
  assert.equal(a, b, 'concurrent opens share the same new runtime');
  assert(a.rpc instanceof CodexSideRpc, 'root reopening must not spawn another app-server');
  assert.equal(a.rpc.owner, rpc);
  assert.equal(await wb.send(parent.id, '重开后继续根任务'), true);
  rpc.emit('message', { method: 'item/agentMessage/delta', params: { threadId: parent.nativeId, itemId: 'root-reply', delta: '独立的根回复' } });
  rpc.emit('message', { method: 'item/agentMessage/delta', params: { threadId: child.nativeId, itemId: 'child-reply', delta: '独立的子回复' } });
  assert.equal(parent.messages.at(-1)?.text, '独立的根回复'); assert.equal(child.messages.at(-1)?.text, '独立的子回复');
  rpc.emit('message', { id: 41, method: 'item/commandExecution/requestApproval', params: { threadId: child.nativeId, itemId: 'cmd', command: 'fixture-only' } });
  assert.equal(child.approvals.length, 1); assert.equal(parent.approvals.length, 0);
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start' && call.params.threadId === parent.nativeId).length, 2);
  assert.equal(parent.messages.filter(message => message.role === 'user').length, 2);
  assert.equal(rpc.calls.filter(call => call.method === 'thread/resume' && call.params.threadId === parent.nativeId).length, 1);
  await wb.closeSession(closeFirst === 'root' ? parent.id : child.id);
  assert.equal(rpc.closed, false, 'either open session keeps the shared writer alive');
  await wb.closeSession(closeFirst === 'root' ? child.id : parent.id);
  assert.equal(rpc.closed, true); assert.equal(rpc.closeCount, 1);
}));

test('repeated root stops reuse one writer and keep guard/auth alive until the last lease closes', () => retainedWriter(async ({ wb, parent, child, owner, rpc }) => {
  let guardCloses = 0, authCloses = 0, refreshes = 0;
  (owner as any).guardConfig = { model_provider: 'guard-fixture' };
  (owner as any).requestGuard = { beforeUpload: () => () => {}, observeRequests: () => () => {}, close: async () => { guardCloses++; } };
  (owner as any).authBridge = { close: async () => { authCloses++; }, refresh: async () => { refreshes++; } };
  for (let i = 0; i < 3; i++) {
    assert.equal(await wb.send(parent.id, '根任务 ' + i), true);
    if (i > 0) assert.equal(rpc.calls.findLast(call => call.method === 'thread/resume')?.params.config.model_provider, 'guard-fixture');
    await wb.stop(parent.id);
    assert.equal(rpc.closed, false); assert.equal(guardCloses, 0); assert.equal(authCloses, 0);
  }
  rpc.emit('message', { id: 99, method: 'account/chatgptAuthTokens/refresh' });
  assert.equal(refreshes, 1);
  await wb.closeSession(child.id);
  assert.equal(rpc.closeCount, 1); assert.equal(guardCloses, 1); assert.equal(authCloses, 1);
}));

test('retained writers accept only known conversation identities in the same local storage', () => retainedWriter(async ({ wb, parent, child, owner }) => {
  await wb.closeSession(parent.id);
  const storage = (owner as any).storage as CodexStorage, hooks = { changed() {}, event() {}, done() {} };
  for (const candidate of [{ ...parent, nativeId: 'other-thread' }, { ...parent, id: 'other-account' }, { ...parent, provider: 'cursor' as const }, { ...parent, codexDesktop: true }])
    assert.equal(await owner.borrowRetainedRuntime(candidate, 'unused', hooks, storage), undefined);
  assert.equal(await owner.borrowRetainedRuntime(parent, 'unused', hooks, { ...storage, home: path.join(storage.home, 'another-account') }), undefined);
  await wb.reopenSession(parent.id);
  const reopened = await (wb as any).runtime(parent) as AgentRuntime;
  assert(reopened.rpc instanceof CodexSideRpc);
  await wb.closeSession(child.id); await wb.closeSession(parent.id);
  assert.equal((wb as any).codexWriters.size, 0);
}));

test('closing and reopening the root keeps nested forks on the original writer', () => retainedWriter(async ({ wb, parent, child, rpc }) => {
  await wb.send(child.id, '子会话运行中');
  await wb.closeSession(parent.id); await wb.reopenSession(parent.id);
  await wb.send(parent.id, '重新打开根会话');
  const nested = await wb.forkSubsession(parent.id, '重开后的分支');
  const nestedRuntime = await (wb as any).runtime(nested) as AgentRuntime;
  assert(nestedRuntime.rpc instanceof CodexSideRpc); assert.equal(nestedRuntime.rpc.owner, rpc);
  await wb.closeSession(parent.id); await wb.closeSession(child.id); assert.equal(rpc.closed, false);
  await wb.closeSession(nested.id); assert.equal(rpc.closeCount, 1);
}));

test('a native turn still stopping cannot receive a replacement user turn', () => retainedWriter(async ({ wb, parent, rpc }) => {
  await wb.send(parent.id, '原任务'); await wb.stop(parent.id);
  rpc.resumeStatus = 'active';
  await assert.rejects(wb.send(parent.id, '等待停止后发送'), /上一轮仍在运行或停止中/);
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 1);
  rpc.resumeStatus = 'idle';
  assert.equal(await wb.send(parent.id, '等待停止后发送'), true);
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 2);
  assert.equal(parent.messages.filter(message => message.role === 'user').length, 2);
}));

test('unexpected writer disconnection also waits for physical process cleanup', () => retainedWriter(async ({ wb, parent, rpc }) => {
  let finishClose!: () => void; rpc.holdClose = new Promise<void>(resolve => { finishClose = resolve; });
  rpc.emit('closed', new Error('fixture transport failure'));
  try {
    let opened = false;
    const replacement = (wb as any).runtime(parent).then((value: AgentRuntime) => { opened = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(opened, false);
    finishClose(); assert.notEqual((await replacement).rpc, rpc);
  } finally { finishClose(); }
}));

test('root reopening waits for a draining writer before creating a replacement', () => retainedWriter(async ({ wb, parent, child, rpc }) => {
  await wb.send(parent.id, '停止根任务'); await wb.stop(parent.id);
  let finishClose!: () => void; rpc.holdClose = new Promise<void>(resolve => { finishClose = resolve; });
  const closeChild = wb.closeSession(child.id);
  try {
    const deadline = Date.now() + 5000;
    while (!rpc.closed) { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
    let opened = false; const replacement = (wb as any).runtime(parent).then((value: AgentRuntime) => { opened = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(opened, false, 'writer exit, not just the closed notification, must release the lock barrier');
    finishClose(); await closeChild;
    assert.notEqual((await replacement).rpc, rpc);
  } finally { finishClose(); await closeChild; }
}));

function complete(rpc: WriterRpc, session: AgentSession) {
  rpc.emit('message', { method: 'turn/completed', params: { threadId: session.nativeId, turn: { id: session.nativeId === 'parent-native' ? 'root-turn' : 'child-turn', status: 'completed' } } });
}

for (const running of [false, true]) test(`native child model/effort changes keep its writer while ${running ? 'running' : 'idle'}`, () => retainedWriter(async ({ wb, child, childRuntime, rpc }) => {
  await wb.send(child.id, '原模型任务');
  if (!running) complete(rpc, child);
  const permissions = child.permissions, history = structuredClone(child.messages), native = child.nativeId;
  const draft = { text: '保留草稿', sourceIds: [], answers: {} }; wb.store.inputs[child.id] = draft;
  const resumes = rpc.calls.filter(call => call.method === 'thread/resume').length;
  await wb.changeModel(child.id, 'second-model'); await wb.changeReasoningEffort(child.id, 'low');
  assert((wb as any).runtimes.get(child.id) === childRuntime, 'model and effort must not close the runtime');
  assert.equal(rpc.calls.some(call => call.method === 'thread/unsubscribe'), false);
  assert.equal(child.permissions, permissions); assert.equal(child.nativeId, native);
  assert.deepEqual(child.messages, history); assert.deepEqual(wb.store.inputs[child.id], draft);
  assert.equal(child.status, running ? 'running' : 'idle');
  const original = rpc.calls.find(call => call.method === 'turn/start')!.params;
  assert.equal(original.model, 'first-model'); assert.equal(original.effort, 'high');
  if (running) {
    assert.equal(child.settingsPending, true);
    assert.equal(child.resolvedModel, 'first-model', 'saving next-turn settings does not relabel the current turn');
    await assert.rejects(wb.send(child.id, '不能插入另一轮'), /正在运行/);
    complete(rpc, child);
  }
  assert.equal(await wb.send(child.id, '新模型任务'), true);
  const next = rpc.calls.filter(call => call.method === 'turn/start').at(-1)!.params;
  assert.equal(next.model, 'second-model'); assert.equal(next.effort, 'low'); assert.equal(next.threadId, native);
  assert.equal(child.resolvedModel, 'second-model'); assert.equal(child.settingsPending, undefined);
  assert.equal(rpc.calls.filter(call => call.method === 'thread/resume').length, resumes, 'the next turn must not resume again');
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 2);
  assert.equal(child.messages.filter(message => message.role === 'user').length, 2);
  complete(rpc, child);
}));

test('parent model changes leave a running native child and both writer leases untouched', () => retainedWriter(async ({ wb, parent, child, owner, childRuntime, rpc }) => {
  await wb.send(child.id, '子任务持续运行');
  await wb.changeModel(parent.id, 'parent-next'); await wb.changeReasoningEffort(parent.id, 'low');
  assert((wb as any).runtimes.get(parent.id) === owner);
  assert((wb as any).runtimes.get(child.id) === childRuntime);
  assert.equal(child.status, 'running'); assert.equal(child.model, 'first-model');
  assert.equal(rpc.calls.some(call => ['turn/interrupt', 'thread/unsubscribe'].includes(call.method)), false);
  assert.equal(await wb.send(parent.id, '根任务新模型'), true);
  assert.equal(rpc.calls.findLast(call => call.method === 'turn/start')?.params.model, 'parent-next');
  complete(rpc, child); complete(rpc, parent);
}));

for (const order of ['model-first', 'permission-first'] as const) test(`next-turn model changes preserve pending permission reconnect: ${order}`, () => retainedWriter(async ({ wb, child, childRuntime, rpc }) => {
  await wb.send(child.id, '旧设置');
  if (order === 'model-first') await wb.changeModel(child.id, 'second-model');
  await wb.changePermissions(child.id, 'full');
  if (order === 'permission-first') await wb.changeModel(child.id, 'second-model');
  complete(rpc, child);
  // A further hot change after completion must not clear the required reconnect.
  await wb.changeReasoningEffort(child.id, 'low');
  assert((wb as any).runtimes.get(child.id) === childRuntime);
  assert.equal(child.settingsPending, true);
  assert.equal(await wb.send(child.id, '应用全部设置'), true);
  const runtime = (wb as any).runtimes.get(child.id) as AgentRuntime;
  assert.notEqual(runtime, childRuntime); assert(runtime.rpc instanceof CodexSideRpc); assert.equal(runtime.rpc.owner, rpc);
  const resume = rpc.calls.findLast(call => call.method === 'thread/resume')!.params;
  assert.equal(resume.model, 'second-model'); assert.equal(resume.config.model_reasoning_effort, 'low');
  assert.equal(resume.approvalPolicy, 'never'); assert.equal(resume.sandbox, 'danger-full-access');
  assert.equal(rpc.calls.filter(call => call.method === 'thread/unsubscribe').length, 1);
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 2);
  assert.equal(child.messages.filter(message => message.role === 'user').length, 2);
  assert.equal(child.settingsPending, undefined); complete(rpc, child);
}));

test('native model/effort selections and history survive storing for a workbench restart', () => retainedWriter(async ({ wb, child, rpc }) => {
  await wb.send(child.id, '重启前的历史'); complete(rpc, child);
  await wb.changeModel(child.id, 'restart-model'); await wb.changeReasoningEffort(child.id, 'low');
  await wb.store.save(); const restored = new Store(wb.store.root); await restored.init();
  const saved = restored.sessions.find(session => session.id === child.id)!;
  assert.equal(saved.model, 'restart-model'); assert.equal(saved.reasoningEffort, 'low');
  assert.equal(saved.nativeId, child.nativeId); assert.deepEqual(saved.fork, JSON.parse(JSON.stringify(child.fork)));
  assert.deepEqual(saved.messages, JSON.parse(JSON.stringify(child.messages)));
}));

for (const configured of [false, true]) test(`clearing native effort restores ${configured ? 'configured' : 'model'} default without reconnecting`, () => retainedWriter(async ({ wb, child, childRuntime, rpc }) => {
  child.mode = 'plan';
  await wb.send(child.id, '高强度'); complete(rpc, child);
  if (configured) rpc.configuredEffort = 'low';
  await wb.changeReasoningEffort(child.id, null);
  assert.equal(await wb.send(child.id, '恢复默认强度'), true);
  assert((wb as any).runtimes.get(child.id) === childRuntime);
  const next = rpc.calls.findLast(call => call.method === 'turn/start')!.params;
  assert.equal(next.effort, configured ? 'low' : 'medium');
  assert.equal(next.collaborationMode.settings.reasoning_effort, next.effort);
  assert.equal(child.reasoningEffort, undefined);
  assert.equal(rpc.calls.some(call => call.method === 'thread/unsubscribe'), false); complete(rpc, child);
}));
