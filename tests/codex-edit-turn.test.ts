import test from 'node:test';
import assert from 'node:assert/strict';
import { editableTurnMessage } from '../src/shared/editable-turn';
import { revertLastCodexTurn } from '../src/core/codex-edit-turn';
import type { AgentSession, Message } from '../src/shared/types';

function fixture() {
  const message: Message = { id: 'native:user', role: 'user', text: 'first', createdAt: '' };
  const session = { id: 's', nativeId: 'thread', provider: 'codex', purpose: 'work', status: 'idle', messages: [message], approvals: [] } as unknown as AgentSession;
  const turn = { id: 'last', status: 'completed', items: [{ type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'first' }] }] };
  const calls: { method: string; params: any }[] = [];
  let rejectRevert: Error | undefined, active = false;
  const rpc = { request: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread', status: { type: active ? 'active' : 'idle' }, turns: [turn] } };
    if (method === 'thread/turns/list') return { data: [turn] };
    if (method === 'thread/revert' && rejectRevert) throw rejectRevert;
    return { thread: { id: 'thread' } };
  } };
  const revert = (before = async () => {}) => revertLastCodexTurn(rpc, session, message, before, () => {});
  return { session, message, turn, calls, revert, fail: (e: Error) => { rejectRevert = e; }, activate: () => { active = true; } };
}
test('only an identifiable idle last user message can be edited; a confirmed steer is final', () => {
  const f = fixture(); assert.equal(editableTurnMessage(f.session), f.message);
  f.session.status = 'running'; assert.equal(editableTurnMessage(f.session), undefined);
  f.session.status = 'idle'; f.session.messages.push({ ...f.message, id: 'guide', steering: true });
  assert.equal(editableTurnMessage(f.session), undefined);
});
test('edit rechecks identity after saving the recovery draft, before native mutation', async () => {
  const f = fixture(); await f.revert();
  assert.deepEqual(f.calls.at(-1), { method: 'thread/revert', params: { threadId: 'thread', beforeTurnId: 'last' } });
  const changed = fixture();
  await assert.rejects(changed.revert(async () => { changed.turn.items[0].id = 'another'; }), /变化/);
  assert.ok(!changed.calls.some(c => c.method === 'thread/revert'));
  const active = fixture(); active.activate(); await assert.rejects(active.revert(), /正在运行/);
});
test('an uncertain revert or legacy shared writer never falls back to count-based rollback', async () => {
  const timed = fixture(); timed.fail(Error('连接超时')); await assert.rejects(timed.revert(), /超时/);
  assert.ok(!timed.calls.some(call => call.method === 'thread/rollback'));
  const shared = fixture(); shared.session.codexDesktop = true; shared.fail(Object.assign(Error('Method not found'), { code: -32601 }));
  await assert.rejects(shared.revert(), /共享会话/); assert.ok(!shared.calls.some(call => call.method === 'thread/rollback'));
  const privateThread = fixture(); privateThread.fail(Object.assign(Error('Method not found'), { code: -32601 })); await privateThread.revert();
  assert.deepEqual(privateThread.calls.at(-1), { method: 'thread/rollback', params: { threadId: 'thread', numTurns: 1 } });
});
