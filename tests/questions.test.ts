import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntime } from '../src/core/agents';
import type { AgentSession, Provider } from '../src/shared/types';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('timeout'); await new Promise(resolve => setTimeout(resolve, 20)); }
}

for (const provider of ['codex', 'cursor'] as Provider[]) test(provider + ': questions are validated and answered on the pending CLI request', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-questions-'));
  const script = path.join(root, 'rpc-agent.mjs');
  await fs.copyFile(path.resolve('tests/fixtures/rpc-agent.mjs'), script);
  const session: AgentSession = { id: randomUUID(), provider, title: 'questions', cwd: root, createdAt: new Date().toISOString(), purpose: 'work', status: 'idle', messages: [], approvals: [], sources: [], autoUpload: false, handoffPath: path.join(root, 'handoff.md') };
  const events: any[] = [], notifications: string[] = [];
  const runtime = new AgentRuntime(session, script, { changed: () => {}, event: value => events.push(value), done: () => {}, needsApproval: kind => notifications.push(kind) }, undefined, { TEST_PROVIDER: provider + '-question' });
  try {
    const prompt = runtime.prompt('开始');
    await until(() => session.approvals.length === 1);
    const request = session.approvals[0];
    assert.equal(notifications[0], 'question');
    assert.equal(request.questions?.[0].text, provider === 'cursor' ? '先做什么？' : '下一步做什么？');
    assert.throws(() => runtime.answer(request.id, 'answer'), /请为每个问题/);
    assert.equal(session.approvals.length, 1, 'invalid answers must leave the request pending');
    if (provider === 'cursor') {
      assert.equal(request.questions?.[1].allowMultiple, true);
      assert.deepEqual(request.questions?.[1].options.map(option => option.id), ['unit', 'ui']);
      assert.throws(() => runtime.answer(request.id, 'answer', { direction: 'verify', checks: ['invalid'] }), /有效答案/);
      assert.throws(() => runtime.answer(request.id, 'answer', { direction: ['verify', 'write'], checks: ['unit'] }), /有效答案/);
      runtime.answer(request.id, 'answer', { direction: 'verify', checks: ['unit', 'ui'] });
      assert.deepEqual(events.at(-1).result.outcome, { outcome: 'answered', answers: [{ questionId: 'direction', selectedOptionIds: ['verify'] }, { questionId: 'checks', selectedOptionIds: ['unit', 'ui'] }] });
    } else {
      assert.throws(() => runtime.answer(request.id, 'answer', { direction: '   ' }), /填写答案/);
      runtime.answer(request.id, 'answer', { direction: '  先整理  ' });
      assert.deepEqual(events.at(-1).result, { answers: { direction: { answers: ['先整理'] } } });
    }
    await prompt;
    await until(() => session.status === 'idle');
    const second = runtime.prompt('下一轮');
    await until(() => session.approvals.length === 1);
    runtime.answer(session.approvals[0].id, 'skip');
    if (provider === 'cursor') assert.equal(events.at(-1).result.outcome.outcome, 'skipped');
    else assert.deepEqual(events.at(-1).result, { answers: { direction: { answers: ['我暂不提供更多信息，请根据已有信息继续。'] } } });
    await second;
  } finally {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});
