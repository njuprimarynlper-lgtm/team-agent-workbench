import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionInputQueue, recoverInputQueue } from '../src/core/session-input-queue';
import type { AgentSession, SessionInput } from '../src/shared/types';

const input = (text: string): SessionInput => ({ text, sourceIds: [], answers: {}, capabilities: [] });
function fixture() {
  const session = { id: 's', purpose: 'work', provider: 'codex', status: 'running', sources: [] } as unknown as AgentSession;
  const sent: SessionInput[] = [], steered: SessionInput[] = [];
  let fail = false, failSave = false, active = false, authorized = true;
  const host = {
    session: () => { if (!authorized) throw new Error('账号已切换'); return session; },
    save: async () => { if (failSave) throw new Error('磁盘已满'); }, changed: () => {},
    blocked: () => active || !!session.closedAt || session.status !== 'idle',
    send: async (_id: string, value: SessionInput, _submitted?: () => void) => { if (fail) throw new Error('请求失败'); sent.push(value); session.status = 'running'; return true; },
    steer: async (_id: string, turn: string, value: SessionInput) => { if (turn !== 'current') throw new Error('轮次已变化'); steered.push(value); return true; },
  };
  const queue = new SessionInputQueue(host);
  return { session, queue, sent, steered, host, setFail: (v: boolean) => { fail = v; }, setSaveFail: (v: boolean) => { failSave = v; }, setActive: (v: boolean) => { active = v; }, switchAccount: () => { authorized = false; } };
}

test('FIFO waits for each turn and approval; concurrent ticks never send twice', async () => {
  const f = fixture();
  await f.queue.enqueue('s', input('first')); await f.queue.enqueue('s', input('second'));
  for (const status of ['running', 'starting', 'approval'] as const) { f.session.status = status; await f.queue.pump('s'); }
  assert.equal(f.sent.length, 0);
  f.session.status = 'idle'; await Promise.all([f.queue.pump('s'), f.queue.pump('s'), f.queue.pump('s')]);
  assert.deepEqual(f.sent.map(i => i.text), ['first']); assert.equal(f.session.inputQueue!.items.length, 1);
  await f.queue.pump('s'); assert.equal(f.sent.length, 1);
  f.session.status = 'idle'; await f.queue.pump('s'); assert.deepEqual(f.sent.map(i => i.text), ['first', 'second']);
});
test('enqueue freezes references and capabilities; editing/removal preserve FIFO', async () => {
  const f = fixture(); f.session.sources.push({ id: 'ref' } as any);
  const a = { ...input('a'), sourceIds: ['ref'], capabilities: [{ id: 'skill', name: 'Skill', kind: 'skill' as const }] };
  await f.queue.enqueue('s', a); a.text = 'mutated'; a.sourceIds.length = 0; a.capabilities[0].name = 'mutated';
  await f.queue.enqueue('s', input('b')); await f.queue.enqueue('s', input('c'));
  const items = f.session.inputQueue!.items;
  await f.queue.update('s', items[0].id, 'edited'); await f.queue.update('s', items[1].id);
  f.session.status = 'idle'; await f.queue.pump('s');
  assert.equal(f.sent[0].text, 'edited'); assert.deepEqual(f.sent[0].sourceIds, ['ref']); assert.equal(f.sent[0].capabilities![0].name, 'Skill');
  assert.equal(f.session.inputQueue!.items[0].input.text, 'c');
});
test('steering consumes just that row and never duplicates it as a new turn', async () => {
  const f = fixture(); await f.queue.enqueue('s', input('first')); await f.queue.enqueue('s', input('steer'));
  await f.queue.steer('s', f.session.inputQueue!.items[1].id, 'current');
  assert.equal(f.steered[0].text, 'steer'); f.session.status = 'idle'; await f.queue.pump('s');
  assert.deepEqual(f.sent.map(i => i.text), ['first']);
});
test('stale steering preserves message and pauses, without falling through to send', async () => {
  const f = fixture(); await f.queue.enqueue('s', input('keep'));
  await assert.rejects(f.queue.steer('s', f.session.inputQueue!.items[0].id, 'old'), /轮次/);
  f.session.status = 'idle'; await f.queue.pump('s'); assert.equal(f.sent.length, 0); assert.equal(f.session.inputQueue!.items[0].state, 'queued');
});
test('stop/pause, close, other work, and account switching prevent dispatch', async () => {
  const f = fixture(); await f.queue.enqueue('s', input('keep')); f.session.status = 'idle';
  await f.queue.pause('s'); await f.queue.pump('s'); assert.equal(f.sent.length, 0);
  await f.queue.pause('s', false); f.setActive(true); await f.queue.pump('s'); assert.equal(f.sent.length, 0);
  f.setActive(false); f.session.closedAt = 'closed'; await f.queue.pump('s'); assert.equal(f.sent.length, 0);
  delete f.session.closedAt; f.switchAccount(); await assert.rejects(f.queue.pump('s'), /账号/); assert.equal(f.sent.length, 0);
});
test('failed send retains current and later rows until explicit resume', async () => {
  const f = fixture(); await f.queue.enqueue('s', input('a')); await f.queue.enqueue('s', input('b')); f.session.status = 'idle';
  f.setFail(true); await f.queue.pump('s'); assert.equal(f.session.inputQueue!.items.length, 2); assert.match(f.session.inputQueue!.error!, /失败/);
  f.setFail(false); await f.queue.pump('s'); assert.equal(f.sent.length, 0);
  await f.queue.pause('s', false); await f.queue.pump('s'); assert.equal(f.sent[0].text, 'a');
});
test('disk failure does not consume or execute a draft', async () => {
  const f = fixture(); f.setSaveFail(true); await assert.rejects(f.queue.enqueue('s', input('a')), /磁盘/); assert.equal(f.session.inputQueue!.items.length, 0);
  f.setSaveFail(false); await f.queue.enqueue('s', input('a')); f.session.status = 'idle';
  f.setSaveFail(true); await f.queue.pump('s'); assert.equal(f.sent.length, 0); assert.equal(f.session.inputQueue!.items[0].state, 'queued');
});
test('a rejected edit does not poison subsequent dispatch', async () => {
  const f = fixture(); await f.queue.enqueue('s', input('kept'));
  await assert.rejects(f.queue.update('s', 'missing', 'bad'), /开始发送/);
  f.session.status = 'idle'; await f.queue.pump('s'); assert.equal(f.sent[0].text, 'kept');
});
test('stopping after provider submission consumes that message instead of replaying it', async () => {
  const f = fixture(); await f.queue.enqueue('s', input('already sent')); await f.queue.enqueue('s', input('next')); f.session.status = 'idle';
  f.host.send = async (_id, value, submitted) => {
    f.sent.push(value); submitted?.(); assert.equal(f.session.inputQueue!.items[0].submitted, true);
    f.session.stoppedAt = 'stopped'; f.session.inputQueue!.paused = true; return false;
  };
  await f.queue.pump('s'); assert.deepEqual(f.session.inputQueue!.items.map(i => i.input.text), ['next']);
  assert.equal(f.session.inputQueue!.paused, true); assert.equal(f.sent.length, 1);
});
test('empty old paused queues do not stall a later running conversation', async () => {
  const f = fixture(); f.session.inputQueue = { items: [], paused: true };
  await f.queue.enqueue('s', input('new turn')); assert.equal(f.session.inputQueue.paused, false);
});
test('restart recovers drafts paused, flags uncertain submissions, and never auto-replays', async () => {
  const f = fixture(); await f.queue.enqueue('s', input('a')); f.session.inputQueue!.items[0].state = 'sending';
  recoverInputQueue(f.session); f.session.status = 'idle'; await f.queue.pump('s');
  assert.equal(f.sent.length, 0); assert.equal(f.session.inputQueue!.items[0].state, 'queued'); assert.match(f.session.inputQueue!.error!, /核对对话/);
});
test('stop during persistence prevents provider invocation; a reserved row cannot be edited or steered twice', async () => {
  const f = fixture(); await f.queue.enqueue('s', input('a')); f.session.status = 'idle';
  let release!: () => void; f.host.save = () => new Promise<void>(r => { release = r; });
  const pumping = f.queue.pump('s'); await Promise.resolve();
  await assert.rejects(f.queue.update('s', f.session.inputQueue!.items[0].id, 'new'), /开始发送/);
  await assert.rejects(f.queue.steer('s', f.session.inputQueue!.items[0].id, 'current'), /正在提交/);
  f.session.inputQueue!.paused = true; f.host.save = async () => {}; release(); await pumping;
  assert.equal(f.sent.length, 0); assert.equal(f.session.inputQueue!.items[0].state, 'queued');
});
