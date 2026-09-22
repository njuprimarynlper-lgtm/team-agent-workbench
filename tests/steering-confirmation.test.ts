import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SteeringConfirmation, prepareSteeringReview, confirmSteeringReview, steeringReviewIsCurrent } from '../src/renderer/steering-confirmation';
import { submitComposerInput } from '../src/renderer/composer-input';
import type { AgentSession, SessionInput, WorkbenchAPI } from '../src/shared/types';

function buttons(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(buttons);
  return [...(node.type === 'button' ? [node] : []), ...buttons(node.props?.children)];
}
const session = { id: 'original-session', title: '正在进行的任务', provider: 'codex', status: 'running' } as AgentSession;
const draft = (): SessionInput => ({ text: '先检查回归，再继续修改', sourceIds: ['file'], answers: {}, capabilities: [{ id: 'skill', kind: 'skill', name: '测试要求' }] });

test('steering review freezes what will be sent; opening and cancelling never call the CLI or clear the draft', async () => {
  const input = draft(), before = structuredClone(input), review = prepareSteeringReview(session, input, 'turn-1', ['检查清单.md']);
  let sent = 0, canceled = 0;
  const props = { review, current: true, busy: false, error: '', close: () => { canceled++; }, confirm: () => { sent++; } };
  const html = renderToStaticMarkup(createElement(SteeringConfirmation, props));
  assert.match(html, /确认引导当前任务/); assert.match(html, /正在进行的任务/); assert.match(html, /先检查回归，再继续修改/);
  assert.match(html, /检查清单.md/); assert.match(html, /测试要求/); assert.match(html, /取消，保留输入/);
  buttons(SteeringConfirmation(props)).find(button => button.props.children === '取消，保留输入').props.onClick();
  assert.equal(sent, 0); assert.equal(canceled, 1); assert.deepEqual(input, before);
  input.text = '后面新输入的内容'; input.sourceIds.push('new-file'); input.capabilities![0].name = '新版能力';
  assert.deepEqual(review.input, before);
  const calls: any[] = [], cleared: string[] = [];
  const api = { call: async (action: string, payload: unknown) => { calls.push({ action, payload }); return true; } } as unknown as WorkbenchAPI;
  await confirmSteeringReview(review, session, 'turn-1', () => submitComposerInput(api, review.sessionId, review.input, review.turnId, () => input, id => cleared.push(id)));
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'session.steer'); assert.equal(calls[0].payload.text, before.text); assert.equal(calls[0].payload.id, session.id);
  assert.deepEqual(cleared, [], 'edits made after the review opened must survive acceptance');
});

test('ended, closed, missing or different turns cannot be confirmed; a failed steer retains the reviewed draft', async () => {
  const input = draft(), review = prepareSteeringReview(session, input, 'turn-1'); let calls = 0;
  for (const [current, turn] of [[{ ...session, status: 'idle' }, undefined], [{ ...session, closedAt: 'closed' }, 'turn-1'], [undefined, 'turn-1'], [{ ...session, id: 'other-session' }, 'turn-1'], [session, 'turn-2']] as const) {
    assert.equal(steeringReviewIsCurrent(review, current as AgentSession | undefined, turn), false);
    await assert.rejects(confirmSteeringReview(review, current as AgentSession | undefined, turn, async () => { calls++; }), /原任务已结束或发生变化/);
  }
  assert.equal(calls, 0);
  for (const [current, busy] of [[false, false], [true, true]]) {
    const tree = SteeringConfirmation({ review, current, busy, error: '', close: () => {}, confirm: () => {} });
    assert.equal(buttons(tree).find(button => button.props.className === 'primary').props.disabled, true);
  }
  const api = { call: async () => { throw new Error('引导未送达'); } } as unknown as WorkbenchAPI;
  let cleared = false;
  await assert.rejects(confirmSteeringReview(review, session, 'turn-1', () => submitComposerInput(api, session.id, review.input, review.turnId, () => input, () => { cleared = true; })), /未送达/);
  assert.equal(cleared, false); assert.deepEqual(input, draft());
  const source = await fs.readFile('src/renderer/main.tsx', 'utf8');
  assert.match(source, /if \(steeringReview \|\| !session/, 'an open review blocks Enter in the underlying composer, even if its task finishes');
  const branch = source.slice(source.indexOf("if (mode === 'steer')"), source.indexOf('const sent = { ...currentInput };', source.indexOf("if (mode === 'steer')")));
  assert.match(branch, /setSteeringReview\(prepareSteeringReview/); assert.doesNotMatch(branch, /sendInput\(|session\.steer/);
});
