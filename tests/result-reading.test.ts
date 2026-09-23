import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReadableResultText, humanReadableWritingGuide, resultPreview } from '../src/shared/result-reading';
import { applyPreparation } from '../src/core/preparation';
import { applyContentMerge } from '../src/core/content-merge';
import type { AgentSession, Draft } from '../src/shared/types';
import { migrateSessionContext, workRecordInstructions } from '../src/core/session-context';

test('result previews preserve complete sentences, decimal values and readable link labels', () => {
  const first = '准确率为 0.91，尚未验证其他数据集。';
  assert.equal(resultPreview(`## 验证结果\n\n${first}\n\n需要继续验证。`, 8), first + ' …');
  assert.equal(resultPreview('参照[验收说明](https://example.org/spec)，使用 `HTTP` 接口。'), '参照验收说明，使用 HTTP 接口。');
  const long = '这是尚未结束但必须完整展示的一句话';
  assert.equal(resultPreview(long, 5), long);
  assert.equal(resultPreview('First result is confirmed. More work remains.', 12), 'First result is confirmed. …');
});

test('AI prose validation rejects machine payloads while preserving explanatory text and code examples', () => {
  for (const text of ['{"result":"ok"}', '[{"finding":"ok"}]', '```python\nprint(1)\n```', '\\u7ed3\\u8bba']) {
    assert.throws(() => assertReadableResultText(text), /可直接阅读/);
  }
  for (const text of ['该接口返回 JSON，状态字段为 `ok`。尚未运行验证。', '[注意] 结论仅适用于当前样本。', '说明：\n\n```json\n{"ok":true}\n```']) assert.doesNotThrow(() => assertReadableResultText(text));
});

test('unreadable new AI responses never replace a prior draft body', () => {
  const draft = { title: '原结果', body: '原正文', mergeSources: [] } as unknown as Draft;
  assert.throws(() => applyPreparation(draft, JSON.stringify({ title: '新结果', body: '{"result":"ok"}' })), /可直接阅读/);
  assert.equal(draft.body, '原正文');
  assert.throws(() => applyContentMerge(draft, JSON.stringify({ title: '合并结果', overview: '```json\n{"result":"ok"}\n```' })), /可直接阅读/);
  assert.equal(draft.body, '原正文');
});

test('the current preparation and merge contracts both reject JSON disguised as human prose', () => {
  const draft = { title: '原结果', body: '原正文', binding: {}, resultRules: { contract: 2, combinationId: 'research', name: '研究', categories: ['finding'] }, preparationEvidenceIds: ['message:m'] } as unknown as Draft;
  const response = JSON.stringify({ artifacts: [{ category: 'finding', origin: 'project', topic: '接口结论', title: '接口约束', body: '{"result":"ok"}', evidenceIds: ['message:m'] }] });
  for (const apply of [applyPreparation, applyContentMerge]) {
    assert.throws(() => apply(draft, response), /可直接阅读/); assert.equal(draft.body, '原正文');
  }
});

test('adding the readability guide still recognizes older stage-summary instructions in stored conversations', () => {
  for (const prior of [false, true]) {
    const session = { nativeId: 'native', handoffPath: 'D:/work/handoff.md', sources: [], messages: [] } as unknown as AgentSession;
    const instructions = workRecordInstructions(session);
    const text = '请继续核对结论。' + (prior ? instructions.slice(0, -humanReadableWritingGuide.length - 1) : instructions);
    session.messages = [{ id: 'u', role: 'user', text, createdAt: '' }, { id: 'a', role: 'assistant', text: '已核对。', createdAt: '' }];
    migrateSessionContext(session);
    assert.equal(session.messages[0].userText, '请继续核对结论。'); assert.equal(session.messages[0].text, text);
    assert.equal(session.messages[0].context?.workRecord, true);
  }
});
