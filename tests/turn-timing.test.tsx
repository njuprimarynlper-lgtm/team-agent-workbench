import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnTimingTracker } from '../src/core/turn-timing';
import { AgentRuntime } from '../src/core/agents';
import { formatElapsed, interruptStoredTimings, messageTimingMap, timingDurations } from '../src/shared/turn-timing';
import type { AgentSession, Message } from '../src/shared/types';
import { MessageTime, SessionTurnProgress, TurnTimingSummary } from '../src/renderer/turn-timing';
import { SessionTranscript } from '../src/renderer/session-transcript';

const start = Date.parse('2026-10-27T06:30:00Z');
function setup() {
  let clock = start;
  const session = { id: 's', nativeId: 'native', provider: 'codex', title: 'timing', purpose: 'work', cwd: '.', createdAt: new Date(start).toISOString(), status: 'running', messages: [], approvals: [], sources: [], autoUpload: false, handoffPath: '' } as AgentSession;
  const tracker = new TurnTimingTracker(session, () => clock);
  return { session, tracker, advance: (ms: number) => { clock += ms; }, at: () => clock };
}
test('observed phases partition elapsed time: parallel tools, approvals and reconnects do not inflate thought time', () => {
  const { session, tracker: t, advance } = setup();
  t.begin('user'); t.wait('network', true); advance(1000); t.wait('network', false);
  t.item('r', 'thinking'); advance(2000); t.item('r', 'thinking', true);
  t.item('a', 'tools'); advance(1000); t.item('b', 'tools'); advance(1000);
  t.wait('approval', true); advance(3000); t.wait('approval', false);
  t.wait('network', true); advance(4000); t.wait('network', false);
  advance(1000); t.item('a', 'tools', true); advance(1000); t.item('b', 'tools', true);
  t.item('reply', 'reply'); advance(2000); t.finish();
  const timing = session.turnTimings![0];
  assert.deepEqual(timing.durations, { thinking: 2000, tools: 4000, reply: 2000, approval: 3000, network: 5000, other: 0 });
  assert.equal(Object.values(timing.durations).reduce((a,b) => a+b,0), 16000);
  assert.equal(timing.thinkingObserved, true); assert.equal(timing.partial, false);
  advance(999000); t.finish(); assert.deepEqual(timingDurations(timing), timing.durations);
});
test('ACP chunks switch phases; tool completion without a start does not invent duration', () => {
  const { session, tracker: t, advance } = setup(); t.begin();
  t.cursor({ sessionUpdate: 'agent_thought_chunk' }); advance(3000);
  t.cursor({ sessionUpdate: 'tool_call', toolCallId: 'x', status: 'in_progress' }); advance(2000);
  t.cursor({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'completed' }); advance(1000);
  t.cursor({ sessionUpdate: 'tool_call_update', toolCallId: 'unknown', status: 'completed' });
  t.cursor({ sessionUpdate: 'agent_message_chunk' }); advance(1000); t.finish('stopped');
  assert.deepEqual(session.turnTimings![0].durations, { thinking: 3000, tools: 2000, reply: 1000, approval: 0, network: 0, other: 1000 });
  assert.equal(session.turnTimings![0].outcome, 'stopped');
});
test('Claude stream block boundaries and tool results preserve separation; subagents are not double counted', () => {
  const { session, tracker: t, advance } = setup(); t.begin();
  const e = (event: any) => t.claude({ type: 'stream_event', event });
  e({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }); advance(5000);
  e({ type: 'content_block_stop', index: 0 });
  t.claude({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool' }] } }); advance(1000);
  t.claude({ type: 'stream_event', parent_tool_use_id: 'tool', event: { type: 'content_block_start', index: 2, content_block: { type: 'thinking' } } }); advance(1000);
  t.claude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool' }] } });
  e({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }); advance(1000);
  e({ type: 'content_block_stop', index: 1 }); t.claude({ type: 'result', is_error: true });
  assert.equal(session.turnTimings![0].durations.thinking, 5000); assert.equal(session.turnTimings![0].durations.tools, 2000); assert.equal(session.turnTimings![0].outcome, 'error');
});
test('reload ends a running timer at its last observation, not the restart time; completed records survive JSON persistence', () => {
  const { session, tracker: t, advance } = setup(); t.begin(); t.item('r', 'thinking'); advance(2500); t.item('r', 'thinking');
  const saved = JSON.parse(JSON.stringify(session)); interruptStoredTimings(saved);
  assert.equal(saved.turnTimings[0].durations.thinking, 2500); assert.equal(saved.turnTimings[0].outcome, 'interrupted'); assert.equal(saved.turnTimings[0].partial, true);
  const next = new TurnTimingTracker(saved, () => start + 86400000); next.begin(); next.finish();
  assert.equal(saved.turnTimings.length, 2); assert.equal(saved.turnTimings[0].durations.thinking, 2500);
});
test('Codex runtime ignores another thread/turn, records native thought events and only one completion', () => {
  const { session, tracker, advance } = setup();
  session.codexRemote = {} as any;
  const runtime = new AgentRuntime(session, 'unused', { changed() {}, event() {}, done() {} }, undefined, {}, new EventEmitter() as any);
  (runtime as any).timing = tracker;
  const emit = (method: string, params: any) => (runtime as any).onMessage({ method, params });
  emit('turn/started', { threadId: 'other', turn: { id: 'bad' } }); assert.equal(session.turnTimings, undefined);
  emit('turn/started', { threadId: 'native', turn: { id: 'turn1' } });
  emit('item/started', { threadId: 'native', turnId: 'turn1', item: { id: 'r', type: 'reasoning' } }); advance(5000);
  emit('turn/completed', { threadId: 'native', turn: { id: 'bad' } }); assert.equal(tracker.active, true);
  emit('item/completed', { threadId: 'native', turnId: 'turn1', item: { id: 'r', type: 'reasoning' } });
  emit('item/agentMessage/delta', { threadId: 'native', turnId: 'turn1', itemId: 'reply', delta: 'answer' }); advance(2000);
  emit('turn/completed', { threadId: 'native', turn: { id: 'turn1', status: 'completed' } });
  emit('turn/completed', { threadId: 'native', turn: { id: 'turn1', status: 'completed' } });
  assert.equal(session.turnTimings!.length, 1); assert.equal(session.turnTimings![0].durations.thinking, 5000); assert.equal(session.turnTimings![0].durations.reply, 2000);
  assert.equal(session.turnTimings![0].partial, false); assert.equal(messageTimingMap(session).get('reply')?.id, session.turnTimings![0].id);
});
test('native mid-turn attachment reports partial observation and never invents thought duration', () => {
  const { session, tracker: t, advance } = setup(); t.begin(undefined, 'native', true); advance(6000); t.finish();
  const html = renderToStaticMarkup(<TurnTimingSummary timing={session.turnTimings![0]}/>);
  assert.match(html, /已记录用时.*6 秒/); assert.match(html, /未提供细分数据/); assert.doesNotMatch(html, /已思考|思考 6/);
  assert.doesNotMatch(renderToStaticMarkup(<SessionTurnProgress session={session}/>), /秒/);
});
test('one summary follows the final reply, even after native hydration changes message ids; old records stay untimed', () => {
  const { session, tracker: t, advance } = setup(); t.begin('user');
  const msg = (id: string, text: string): Message => ({ id, role: 'assistant', createdAt: new Date(start).toISOString(), text });
  t.message(msg('c', 'working')); t.message(msg('a', 'done')); advance(4000); t.finish();
  session.messages = [msg('native:c', 'working'), msg('native:a', 'done')]; session.status = 'idle';
  assert.deepEqual([...messageTimingMap(session).keys()], ['native:a']);
  const html = renderToStaticMarkup(<SessionTranscript session={session} renderMessage={message => <p>{message.text}</p>}/>);
  assert.equal(html.split('turn-timing-summary').length-1, 1); assert(html.indexOf('done') < html.indexOf('整轮用时'));
  const legacy = renderToStaticMarkup(<SessionTranscript session={{ ...session, turnTimings: undefined }} renderMessage={m => <p>{m.text}</p>}/>);
  assert.doesNotMatch(legacy, /整轮用时|已思考/);
});
test('timestamps contain a date and clock, omit invalid legacy values, and elapsed formatting handles hours', () => {
  const html = renderToStaticMarkup(<MessageTime at="2026-10-27T06:30:00Z"/>);
  assert.match(html, /2026.*10.*27/); assert.match(html, /\d{2}:30/); assert.match(html, /datetime="2026-10-27T06:30:00Z"/i);
  assert.equal(renderToStaticMarkup(<MessageTime at="invalid"/>), '');
  assert.equal(renderToStaticMarkup(<MessageTime at="1970-01-01T00:00:00Z"/>), '');
  assert.equal(formatElapsed(61000), '1 分 1 秒'); assert.equal(formatElapsed(3600000), '1 小时 0 分');
});

test('actual store save/reload preserves completed timings and seals incomplete observations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-timing-store-'));
  try {
    const { session, tracker: t, advance } = setup();
    t.begin('first'); advance(5000); t.finish();
    t.begin('second'); t.item('r', 'thinking'); advance(3000); t.item('r', 'thinking');
    const store = new Store(root); await store.init(); store.sessions.push(session); await store.save();
    const restored = new Store(root); await restored.init();
    assert.equal(restored.sessions[0].turnTimings?.[0].durations.other, 5000);
    assert.equal(restored.sessions[0].turnTimings?.[1].durations.thinking, 3000);
    assert.equal(restored.sessions[0].turnTimings?.[1].outcome, 'interrupted');
  } finally { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); }
});

test('stopped tool-only rounds stay at their own position and pruned native history does not dump orphan timers', () => {
  const { session, tracker: t, advance } = setup();
  session.messages = [{ id: 'u', role: 'user', text: 'do', createdAt: new Date(start).toISOString() }, { id: 'tool', role: 'tool', text: 'read', createdAt: new Date(start).toISOString() }, { id: 'next', role: 'user', text: 'next', createdAt: new Date(start).toISOString() }];
  t.begin('u'); advance(7000); t.finish('stopped');
  assert.equal(messageTimingMap(session).get('tool')?.outcome, 'stopped');
  const render = () => renderToStaticMarkup(<SessionTranscript session={session} renderMessage={m => <p>{m.text}</p>}/>);
  const html = render(); assert(html.indexOf('已停止') < html.indexOf('<p>next</p>'));
  session.messages = session.messages.slice(-1); assert.doesNotMatch(render(), /整轮用时|已停止/);
});
