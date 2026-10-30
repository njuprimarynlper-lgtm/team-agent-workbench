import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgentRuntime } from '../src/core/agents';
import { capacityFallbackModel, isCodexCapacityError } from '../src/core/codex-capacity';
import type { AgentRpc } from '../src/core/rpc';
import type { AgentSession } from '../src/shared/types';

const capacity = { message: 'The model is at capacity. Please try a different model.', codexErrorInfo: 'serverOverloaded' };
const model = (id: string, isDefault = false) => ({ model: id, isDefault, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'] });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw Error('fixture timeout'); await tick(); } }
class Native extends EventEmitter implements AgentRpc {
  calls: { method: string; params: any }[] = []; turns: any[] = []; busy = false;
  models = [model('original'), model('backup', true), model('last')];
  rejectFirst = false; catalogGate?: Promise<void>; catalogError = false; acknowledgeGate?: Promise<void>;
  event(method: string, params: any = {}) { this.emit('message', { method, params: { threadId: 'thread', ...params } }); }
  async request(method: string, params: any = {}, _timeout?: number, written?: () => void): Promise<any> {
    this.calls.push({ method, params: structuredClone(params) }); written?.();
    if (method === 'initialize') return {};
    if (method === 'thread/start') return { thread: { id: 'thread' }, model: 'original', reasoningEffort: 'high' };
    if (method === 'thread/read') return { thread: { id: 'thread', status: { type: this.busy ? 'active' : 'idle' }, turns: this.turns } };
    if (method === 'collaborationMode/list') return { data: [{ mode: 'plan', model: 'original' }] };
    if (method === 'model/list') { await this.catalogGate; if (this.catalogError) throw Error('catalog offline'); return { data: this.models }; }
    if (method === 'turn/start') {
      if (this.rejectFirst && !this.turns.length && this.calls.filter(c => c.method === 'turn/start').length === 1) throw Object.assign(Error(capacity.message), capacity);
      const turn = { id: 'turn-' + (this.turns.length + 1), status: 'inProgress', items: params.input.length ? [{ type: 'userMessage', content: params.input }] : [] };
      this.turns.push(turn); this.event('turn/started', { turn });
      if (turn.id === 'turn-1') await this.acknowledgeGate;
      return { turn };
    }
    if (method === 'turn/interrupt') return {};
    throw Error('Unexpected method: ' + method);
  }
  complete(error?: any, status = error ? 'failed' : 'completed') {
    const turn = this.turns.at(-1)!; turn.status = status; turn.error = error;
    this.event('turn/completed', { turn });
  }
  notify() {} respond() {} reject() {} async close() {}
}
function setup() {
  const rpc = new Native(), events: any[] = [];
  const session = { id: 'session', provider: 'codex', purpose: 'work', cwd: process.cwd(), status: 'idle', messages: [], approvals: [], sources: [], permissionMode: 'inherit', reasoningEffort: 'high', model: 'original' } as unknown as AgentSession;
  let done = 0;
  const runtime = new AgentRuntime(session, 'unused', { changed() {}, event(e) { events.push(e); }, done() { done++; } }, undefined, {}, rpc);
  return { rpc, session, runtime, events, done: () => done };
}

test('capacity detection is narrow and excludes quota, policy, network and app-server ingress overload', () => {
  for (const error of [capacity, { codexErrorInfo: 'serverOverloaded' }, { code: 'model_capacity_exceeded' }, 'The model has reached its capacity limit', '模型当前容量不足']) assert(isCodexCapacityError(error));
  for (const error of [
    { code: -32001, message: 'Server overloaded; retry later.' }, { codexErrorInfo: 'usageLimitExceeded', message: 'model capacity limit' },
    { codexErrorInfo: 'cyberPolicy', message: 'model capacity' }, { code: 'usage_limit_exceeded', message: 'model capacity' }, '429 quota exceeded', 'context window capacity exceeded', 'insufficient credits',
    'model.py file not found', 'HTTP 503 Service Unavailable', 'ETIMEDOUT', 'Unauthorized', 'The model does not exist', 'storage capacity reached',
  ]) assert(!isCodexCapacityError(error), JSON.stringify(error));
});
test('fallback selection uses catalog default/order, compatible effort, and excludes hidden/attempted/incompatible models', () => {
  const models = [model('original'), { ...model('hidden', true), hidden: true }, { ...model('text-only', true), inputModalities: ['text'] }, model('other'), model('preferred', true)];
  assert.deepEqual(capacityFallbackModel(models, new Set(['original']), 'high'), { model: 'preferred', effort: 'medium' });
  assert.equal(capacityFallbackModel(models, new Set(['original', 'preferred']), 'medium')?.model, 'other');
  assert.equal(capacityFallbackModel([], new Set()), undefined);
});
test('accepted capacity failure continues same native history, updates Plan effort, and completes only once', async () => {
  const f = setup(); f.session.mode = 'plan'; let release!: () => void;
  f.rpc.catalogGate = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.runtime.prompt('KEEP_LATEST');
    f.rpc.event('error', { turnId: 'turn-1', error: capacity, willRetry: false });
    assert.equal(f.session.status, 'running'); assert.equal(f.done(), 0); assert.equal(f.rpc.calls.filter(c => c.method === 'model/list').length, 0);
    f.rpc.complete(capacity); f.rpc.complete(capacity);
    assert.equal(f.session.status, 'running'); assert.equal(f.done(), 0);
    await assert.rejects(f.runtime.prompt('do not interleave'), /仍在运行/);
    release(); await until(() => f.rpc.turns.length === 2);
    const retry = f.rpc.calls.filter(c => c.method === 'turn/start')[1].params;
    assert.equal(retry.threadId, 'thread'); assert.deepEqual(retry.input, []); assert.equal(retry.model, 'backup'); assert.equal(retry.effort, 'medium');
    assert.equal(retry.collaborationMode.settings.model, 'backup'); assert.equal(retry.collaborationMode.settings.reasoning_effort, 'medium');
    assert.equal(f.session.messages.filter(m => m.role === 'user').length, 1); assert.match(f.session.messages.at(-1)!.text, /自动切换.*backup/);
    assert.equal(f.session.model, 'backup'); assert.equal(f.session.resolvedModel, 'backup');
    f.rpc.event('turn/completed', { turn: f.rpc.turns[0] }); assert.equal(f.session.status, 'running');
    f.rpc.complete(); f.rpc.complete();
    assert.equal(f.session.status, 'idle'); assert.equal(f.done(), 1); assert.equal(f.session.turnTimings?.length, 1);
  } finally { release(); await f.runtime.close(); }
});
test('rejected start retries original input exactly, without a second displayed user message', async () => {
  const f = setup(); f.rpc.rejectFirst = true;
  try {
    await f.runtime.prompt('KEEP_REJECTED'); await until(() => f.rpc.turns.length === 1);
    const starts = f.rpc.calls.filter(c => c.method === 'turn/start');
    assert.deepEqual(starts[0].params.input, starts[1].params.input); assert.equal(starts[1].params.model, 'backup');
    assert.equal(f.session.messages.filter(m => m.role === 'user').length, 1);
    f.rpc.complete(); assert.equal(f.done(), 1);
  } finally { await f.runtime.close(); }
});
test('at most two alternative models, with no loop or duplicate input if all are at capacity', async () => {
  const f = setup();
  try {
    await f.runtime.prompt('LATEST'); f.rpc.complete(capacity); await until(() => f.rpc.turns.length === 2);
    f.rpc.complete(capacity); await until(() => f.rpc.turns.length === 3);
    f.rpc.complete(capacity); await tick();
    assert.deepEqual(f.rpc.calls.filter(c => c.method === 'turn/start').map(c => c.params.model), ['original', 'backup', 'last']);
    assert.equal(f.session.status, 'error'); assert.match(f.session.error!, /2 个备选模型/); assert.equal(f.done(), 1);
  } finally { await f.runtime.close(); }
});
for (const scenario of ['reply', 'tool', 'rerouted', 'approval', 'foreign-turn', 'missing-history', 'catalog-error', 'no-candidate', 'cancel', 'close', 'quota', 'network', 'interrupted'] as const) test(`no unsafe automatic replay: ${scenario}`, async () => {
  const f = setup(); let release!: () => void;
  try {
    await f.runtime.prompt('LATEST');
    if (scenario === 'reply') f.rpc.event('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'answer', delta: 'partial answer' });
    if (scenario === 'tool') f.rpc.event('item/started', { turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd', command: 'do-work' } });
    if (scenario === 'approval') f.rpc.emit('message', { id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn-1' } });
    if (scenario === 'rerouted') f.rpc.event('model/rerouted', { turnId: 'turn-1', fromModel: 'original', toModel: 'service-choice', reason: 'highRiskCyberActivity' });
    if (scenario === 'foreign-turn') f.rpc.busy = true;
    if (scenario === 'missing-history') f.rpc.turns[0].items = [];
    if (scenario === 'catalog-error') f.rpc.catalogError = true;
    if (scenario === 'no-candidate') f.rpc.models = [model('original')];
    if (scenario === 'cancel' || scenario === 'close') f.rpc.catalogGate = new Promise<void>(resolve => { release = resolve; });
    f.rpc.complete(scenario === 'quota' ? { message: 'usage limit reached', codexErrorInfo: 'usageLimitExceeded' } : scenario === 'network' ? { message: 'ECONNRESET' } : capacity, scenario === 'interrupted' ? 'interrupted' : 'failed');
    if (scenario === 'cancel') await f.runtime.cancel();
    if (scenario === 'close') await f.runtime.close();
    release?.(); await until(() => f.session.status !== 'running' && f.session.status !== 'approval'); await tick();
    assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').length, 1);
    assert.equal(f.session.messages.filter(m => m.role === 'user').length, 1);
  } finally { release?.(); await f.runtime.close(); }
});
test('native transient retry is left to Codex, and unrelated thread events cannot trigger fallback', async () => {
  const f = setup();
  try {
    await f.runtime.prompt('LATEST');
    f.rpc.event('error', { turnId: 'turn-1', error: capacity, willRetry: true });
    f.rpc.event('turn/completed', { threadId: 'other', turn: { id: 'other-turn', status: 'failed', error: capacity } });
    assert.equal(f.rpc.calls.filter(c => c.method === 'model/list').length, 0); assert.equal(f.session.status, 'running');
    f.rpc.complete(); assert.equal(f.done(), 1);
  } finally { await f.runtime.close(); }
});
test('a late original acknowledgement cannot replace the fallback turn id or release its queue', async () => {
  const f = setup(); let release!: () => void;
  f.rpc.acknowledgeGate = new Promise<void>(resolve => { release = resolve; });
  try {
    const sending = f.runtime.prompt('LATEST'); await until(() => f.rpc.turns.length === 1);
    f.rpc.complete(capacity); await until(() => f.rpc.turns.length === 2);
    release(); await sending;
    assert.equal(f.runtime.activeTurnId, 'turn-2'); assert.equal(f.done(), 0);
    f.rpc.complete(); assert.equal(f.done(), 1);
    await f.runtime.prompt('NEXT'); assert.equal(f.rpc.turns.length, 3); assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').at(-1)!.params.model, 'backup');
    f.rpc.complete(); assert.equal(f.done(), 2);
  } finally { release(); await f.runtime.close(); }
});
test('stop during a pending acknowledgement interrupts that turn and never starts a fallback', async () => {
  const f = setup(); let release!: () => void;
  f.rpc.acknowledgeGate = new Promise<void>(resolve => { release = resolve; });
  try {
    const sending = f.runtime.prompt('LATEST'); await until(() => f.rpc.turns.length === 1);
    await f.runtime.cancel(); release(); await sending;
    assert(f.rpc.calls.some(c => c.method === 'turn/interrupt' && c.params.turnId === 'turn-1'));
    f.rpc.complete(undefined, 'interrupted');
    assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').length, 1);
  } finally { release(); await f.runtime.close(); }
});
test('terminal success wins over an earlier capacity error notification', async () => {
  const f = setup();
  try {
    await f.runtime.prompt('LATEST');
    f.rpc.event('error', { turnId: 'turn-1', error: capacity, willRetry: false });
    f.rpc.complete(); await tick();
    assert.equal(f.session.status, 'idle'); assert.equal(f.rpc.calls.filter(c => c.method === 'model/list').length, 0);
  } finally { await f.runtime.close(); }
});
test('error without a terminal event never retries and blocks a new submission until the turn ends', async () => {
  const f = setup();
  try {
    await f.runtime.prompt('LATEST');
    f.rpc.event('error', { turnId: 'turn-1', error: capacity, willRetry: false });
    await new Promise(resolve => setTimeout(resolve, 5100));
    assert.equal(f.session.status, 'error'); assert.match(f.session.error!, /尚未确认/);
    await assert.rejects(f.runtime.prompt('NEW'), /上一轮/);
    assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').length, 1);
    f.rpc.complete(undefined, 'interrupted');
    await f.runtime.prompt('AFTER_CONFIRMED_END'); assert.equal(f.rpc.turns.length, 2);
    f.rpc.complete();
  } finally { await f.runtime.close(); }
});
test('broken model pagination is bounded and cannot cause another turn', async () => {
  const f = setup(), request = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (...args) => {
    const result = await request(...args);
    return args[0] === 'model/list' ? { ...result, nextCursor: 'repeated' } : result;
  };
  try {
    await f.runtime.prompt('LATEST'); f.rpc.complete(capacity); await until(() => f.session.status === 'error');
    assert.equal(f.rpc.calls.filter(c => c.method === 'model/list').length, 2);
    assert.equal(f.rpc.turns.length, 1); assert.match(f.session.error!, /分页异常/);
  } finally { await f.runtime.close(); }
});
