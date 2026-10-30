import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgentRuntime } from '../src/core/agents';
import type { AgentSession } from '../src/shared/types';
import type { AgentRpc } from '../src/core/rpc';

test('Cursor compaction stays invisible, holds the turn open and excludes maintenance from reply timing', async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => release = r), compact = new Promise<void>(r => started = r);
  class Rpc extends EventEmitter implements AgentRpc {
    async request(method: string, _params?: any, _timeout?: number, written?: () => void) {
      assert.equal(method, 'session/prompt'); written?.();
      this.emit('message', { method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'final answer' } } } });
      this.emit('message', { method: '_workbench/cursorCompaction', params: { sessionId: 'native', status: 'started', phase: 'after' } });
      started(); await gate;
      this.emit('message', { method: '_workbench/cursorCompaction', params: { sessionId: 'native', status: 'completed', phase: 'after' } });
      return { stopReason: 'end_turn' };
    }
    notify() {} respond() {} reject() {} async close() {}
  }
  const session = { id: 'local', nativeId: 'native', provider: 'cursor', purpose: 'work', cwd: process.cwd(), status: 'idle', messages: [], approvals: [], sources: [] } as unknown as AgentSession;
  let done = 0;
  const rpc = new Rpc(), runtime = new AgentRuntime(session, '', { changed() {}, event() {}, done() { done++; } }, undefined, {}, rpc);
  (runtime as any).initialized = true;
  try {
    const run = runtime.prompt('hello'); await compact;
    assert.equal(session.status, 'running'); assert.equal(done, 0);
    assert.equal(session.turnTimings?.length, 1); assert(session.turnTimings![0].finishedAt);
    assert.deepEqual(session.messages.map(m => [m.role, m.text]), [['user', 'hello'], ['assistant', 'final answer']]);
    await assert.rejects(runtime.prompt('next'), /仍在运行/);
    release(); await run; assert.equal(session.status, 'idle'); assert.equal(done, 1);
    rpc.emit('message', { method: '_workbench/cursorCompaction', params: { sessionId: 'native', status: 'uncertain', phase: 'after' } });
    const before = session.messages.length; await assert.rejects(runtime.prompt('unsafe'), /尚未确认/); assert.equal(session.messages.length, before);
  } finally { release(); await runtime.close(); }
});

test('an unconfirmed adapter is rejected before authenticating, creating a native session or sending the prompt', async () => {
  const calls: string[] = [];
  class Rpc extends EventEmitter implements AgentRpc {
    async request(method: string) { calls.push(method); return {}; }
    notify() {} respond() {} reject() {} async close() {}
  }
  const session = { id: 'local', provider: 'cursor', purpose: 'work', cwd: process.cwd(), status: 'idle', messages: [], approvals: [], sources: [], permissionMode: 'inherit' } as unknown as AgentSession;
  const runtime = new AgentRuntime(session, '', { changed() {}, event() {}, done() {} }, undefined, {}, new Rpc());
  (runtime as any).cursorGuardExpected = true;
  try {
    await assert.rejects(runtime.prompt('must not send'), /未启用 1 MB 自动压缩适配/);
    assert.deepEqual(calls, ['initialize']); assert.equal(session.messages.length, 0);
    assert.notEqual(session.status, 'starting');
  } finally { await runtime.close(); }
});
