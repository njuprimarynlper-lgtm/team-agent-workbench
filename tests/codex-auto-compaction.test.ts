import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexAutoCompaction } from '../src/core/codex-auto-compaction';
import type { CodexRequestGuard, GuardRequestSize } from '../src/core/codex-request-guard';
import type { AgentRpc } from '../src/core/rpc';

class Requests {
  listeners = new Set<(request: GuardRequestSize) => void>();
  observeRequests(listener: (request: GuardRequestSize) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  send(inputBytes = 1000, threadId = 'a') { for (const listener of this.listeners) listener({ inputBytes, threadId, budget: 1000 }); }
}
class Rpc extends EventEmitter implements AgentRpc {
  calls: { method: string; params: any }[] = [];
  fail?: any; idle = false;
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === 'thread/compact/start' && this.fail) throw this.fail;
    return method === 'thread/read' ? { thread: { status: { type: this.idle ? 'idle' : 'active' } } } : {};
  }
  notify() {} respond() {} reject() {} async close() {}
}
function setup(timeout?: number) {
  const requests = new Requests(), rpc = new Rpc();
  const compact = new CodexAutoCompaction(requests as unknown as CodexRequestGuard, rpc, () => 'a', timeout);
  const event = (method: string, extra: any = {}, threadId = 'a') => compact.handle(method, { threadId, ...extra });
  const begin = (id = 'compact-1') => event('turn/started', { turn: { id } });
  const item = (id = 'compact-1') => event('item/completed', { turnId: id, item: { id: 'compacted', type: 'contextCompaction' } });
  const end = (id = 'compact-1', status = 'completed') => event('turn/completed', { turn: { id, status } });
  return { requests, rpc, compact, event, begin, item, end };
}

test('oversize requests coalesce; empty RPC acknowledgement and one lifecycle event cannot release the turn', async () => {
  const f = setup();
  try {
    f.requests.send(); f.requests.send(1100); f.requests.send(1200);
    const result = f.compact.start('user-turn')!; let finished = false; void result.then(() => { finished = true; });
    await Promise.resolve(); assert.equal(finished, false); assert.equal(f.rpc.calls.length, 1);
    assert.equal(f.compact.start('user-turn'), undefined);
    assert.equal(f.event('turn/completed', { turn: { id: 'user-turn', status: 'completed' } }), true);
    f.begin(); f.end(); await Promise.resolve(); assert.equal(finished, false);
    f.item(); assert.equal((await result).status, 'completed');
    assert.equal(f.end(), true, 'duplicate compact completions stay out of user accounting');
    await f.compact.assertReady();
  } finally { f.compact.close(); }
});

test('successful compaction rearms only after headroom or substantial further growth', async () => {
  const f = setup();
  try {
    f.requests.send(1100); const first = f.compact.start()!; f.begin(); f.item(); f.end(); await first;
    for (const bytes of [1100, 1150, 1319]) { f.requests.send(bytes); assert.equal(f.compact.start(), undefined); }
    f.requests.send(1320); const growth = f.compact.start()!; f.begin('compact-2'); f.item('compact-2'); f.end('compact-2'); await growth;
    f.requests.send(700); f.requests.send(1000); const rearmed = f.compact.start()!;
    assert(rearmed); f.begin('compact-3'); f.item('compact-3'); f.end('compact-3'); await rearmed;
  } finally { f.compact.close(); }
});

test('native automatic compaction clears a pending manual compact; independent threads share only the HTTP guard', async () => {
  const f = setup(), other = new CodexAutoCompaction(f.requests as unknown as CodexRequestGuard, f.rpc, () => 'b');
  try {
    f.requests.send(1100, 'b'); assert.equal(f.compact.start(), undefined);
    f.requests.send(1100); f.item('native-auto'); assert.equal(f.compact.start(), undefined);
    const job = other.start()!; assert(job); assert.equal(f.rpc.calls[0].params.threadId, 'b');
    assert.equal(other.handle('turn/started', { threadId: 'a', turn: { id: 'wrong' } }), false);
    other.close(); assert.equal((await job).status, 'closed');
    assert.equal(f.requests.listeners.size, 1);
  } finally { other.close(); f.compact.close(); }
  assert.equal(f.requests.listeners.size, 0);
});

test('failed native turns back off and do not restart compaction on the next oversized request', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const f = setup();
  try {
    f.requests.send(); const job = f.compact.start()!; f.begin(); f.end('compact-1', 'failed');
    assert.equal((await job).status, 'failed'); await f.compact.assertReady();
    f.requests.send(2000); assert.equal(f.compact.start(), undefined);
    t.mock.timers.tick(60_001); f.requests.send(2000);
    const next = f.compact.start()!; assert(next); f.compact.close(); await next;
  } finally { f.compact.close(); }
});

test('unsupported compact RPC disables automatic attempts for this connection without blocking chat', async () => {
  const f = setup(); f.rpc.fail = Object.assign(Error('Method not found'), { code: -32601 });
  try {
    f.requests.send(); assert.equal((await f.compact.start()!).status, 'failed'); await f.compact.assertReady();
    f.requests.send(100); f.requests.send(4000); assert.equal(f.compact.start(), undefined);
    assert.equal(f.rpc.calls.length, 1);
  } finally { f.compact.close(); }
});

test('timeout never assumes cancellation: block until native completion or an acknowledged idle read', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const f = setup(1000);
  try {
    f.requests.send(); const job = f.compact.start()!; await Promise.resolve(); f.begin();
    t.mock.timers.tick(1001); assert.equal((await job).status, 'uncertain');
    assert(f.rpc.calls.some(call => call.method === 'turn/interrupt'));
    await assert.rejects(f.compact.assertReady(), /尚未确认/);
    f.end('compact-1', 'interrupted'); await f.compact.assertReady();
  } finally { f.compact.close(); }
});

test('ambiguous start cannot be cleared by an idle read or followed by another compact', async () => {
  const f = setup(); f.rpc.fail = Error('connection lost'); f.rpc.idle = true;
  try {
    f.requests.send(); assert.equal((await f.compact.start()!).status, 'uncertain');
    await assert.rejects(f.compact.assertReady(), /尚未确认/);
    assert(!f.rpc.calls.some(call => call.method === 'thread/read'));
    f.requests.send(5000); assert.equal(f.compact.start(), undefined);
    f.begin(); f.item(); f.end(); await f.compact.assertReady();
  } finally { f.compact.close(); }
});

test('acknowledged timeout can reconcile idle state while old user events cannot clear the barrier', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const f = setup(1000);
  try {
    f.requests.send(); const job = f.compact.start('user-turn')!; await Promise.resolve();
    f.begin();
    t.mock.timers.tick(1001); assert.equal((await job).status, 'uncertain');
    f.event('turn/started', { turn: { id: 'user-turn' } });
    f.event('turn/completed', { turn: { id: 'user-turn', status: 'completed' } });
    await assert.rejects(f.compact.assertReady(), /尚未确认/);
    f.rpc.idle = true; await f.compact.assertReady();
    assert(f.rpc.calls.some(call => call.method === 'thread/read'));
  } finally { f.compact.close(); }
});
