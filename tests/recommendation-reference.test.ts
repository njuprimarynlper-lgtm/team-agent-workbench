import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { sessionContext } from '../src/core/session-context';
import { sourceWasAccepted, isRecommendationSource } from '../src/shared/session-context';
import { pendingComposerReferences } from '../src/renderer/composer-references';
import { sessionWithAvailableReferences } from '../src/shared/session-result-references';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import { passingValueReview } from './fixtures/rsi-value-review';
// @ts-expect-error Local protocol fixture; no account or real model calls.
import { authLauncher } from './fixtures/auth-launcher.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recommendation-reference-'));
  const wb = new Workbench(path.join(root, 'store'), () => {}, () => {}, undefined, () => ({ HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: 'localhost,127.0.0.1' }));
  await wb.store.init(); grantTestWorkspace(wb, root); await wb.projectSync.init();
  wb.requireAuth = async () => {};
  wb.catalog = async () => ({ defaultModel: 'fixture-model', models: [], quota: { windows: [], url: '', detail: '' }, checkedAt: '' });
  const session = await wb.createSession('codex', root, offlineProjectId, 'work', undefined, 'fixture-model');
  session.messages.push({ id: randomUUID(), role: 'user', text: '固定开发集检查边界 F1，验收要求是 F1 达到 0.9；保留验证依据。', createdAt: new Date().toISOString() });
  wb.rsi.runText = async (_session, prompt) => {
    const judged = passingValueReview(prompt); if (judged) return judged;
    const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]), evidenceIds = data.evidence.slice(0, 2).map((item: any) => item.id);
    return JSON.stringify({ state: { progress: '尚待验证', blockers: [], unknowns: ['边界 F1'], evidenceIds }, suggestions: [{ title: '补齐边界样本验证', action: '固定开发集并独立评估边界 F1，保留实际评估输出。', reason: '当前只有验收要求，没有独立评估记录。', evidenceIds, conditions: ['不修改冻结测试集'], uncertainty: '真实提升尚未验证', priority: .8 }] });
  };
  await wb.rsi.configure(offlineProjectId, { autoLearn: false });
  await wb.rsi.start(offlineProjectId, 'recommend'); await wb.rsi.settled();
  const suggestion = (await wb.rsi.inbox(offlineProjectId)).items[0]; assert(suggestion);
  const accepted = await wb.feedbackRecommendation(offlineProjectId, { suggestionId: suggestion.id, kind: 'accepted', requestId: randomUUID() });
  const reaction = { suggestionId: suggestion.id, kind: 'supplement', requestId: randomUUID(), expectedDecisionId: accepted.id, linkedSessionId: session.id, text: '推荐需要更充分的背景', feedbackTarget: 'recommendation' };
  return { wb, session, root, suggestion, accepted, reaction, close: async () => { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); } };
}

test('linking an accepted recommendation freezes a removable next-message reference without changing a running turn or draft', async () => {
  const f = await fixture();
  try {
    f.session.status = 'running'; const before = structuredClone(f.session.messages);
    await f.wb.saveInput(f.session.id, { text: '保留我的草稿', sourceIds: [], answers: {} });
    const result = await f.wb.feedbackRecommendation(offlineProjectId, f.reaction);
    assert.equal(result.reference?.status, 'ready'); assert.equal(f.session.status, 'running');
    assert.deepEqual(f.session.messages, before); assert.equal(f.wb.store.inputs[f.session.id].text, '保留我的草稿');
    assert.equal(f.session.sources.length, 1); const source = f.session.sources[0];
    assert(isRecommendationSource(source)); assert.equal(pendingComposerReferences(f.session, [])[0].removable, true);
    const body = await fs.readFile(source.localPath, 'utf8'); assert(body.includes(f.suggestion.action)); assert(body.includes(f.suggestion.reason)); assert(body.includes('不修改冻结测试集')); assert(!body.includes(f.reaction.text));
    assert.equal((await f.wb.rsi.inbox(offlineProjectId)).items.length, 0);
    const again = await f.wb.feedbackRecommendation(offlineProjectId, f.reaction); assert.equal(again.id, result.id); assert.equal(f.session.sources.length, 1);
    await f.wb.detachPendingSource(f.session.id, source.id); assert.equal(f.session.sources.length, 0);
    await f.wb.feedbackRecommendation(offlineProjectId, f.reaction); assert.equal(f.session.sources.length, 0, 'late duplicate acknowledgements cannot restore a reference the user removed');
  } finally { await f.close(); }
});

test('reference persistence failure keeps the recommendation visible and the same request retries without duplicating the review', async () => {
  const f = await fixture();
  try {
    const save = f.wb.store.save.bind(f.wb.store); f.wb.store.save = async () => { throw Error('disk busy'); };
    await assert.rejects(f.wb.feedbackRecommendation(offlineProjectId, f.reaction), /disk busy/);
    assert.equal(f.session.sources.length, 0);
    assert.equal((await f.wb.rsi.inbox(offlineProjectId)).items[0].review.closed, false);
    f.wb.store.save = save;
    await f.wb.feedbackRecommendation(offlineProjectId, f.reaction);
    assert.equal(f.session.sources.length, 1); assert.equal((await f.wb.rsi.view(offlineProjectId)).events.filter(event => event.requestId === f.reaction.requestId).length, 1);
  } finally { await f.close(); }
});

test('changing or rejecting a link supersedes old references while preserving snapshots and sent history', async () => {
  const f = await fixture();
  try {
    await f.wb.feedbackRecommendation(offlineProjectId, f.reaction); const original = f.session.sources[0];
    const target = await f.wb.createSession('cursor', f.root, offlineProjectId);
    await f.wb.feedbackRecommendation(offlineProjectId, { ...f.reaction, requestId: randomUUID(), linkedSessionId: target.id });
    assert.equal(sessionWithAvailableReferences(f.session, []).sources.length, 0); assert.equal(target.sources.length, 1);
    assert((await fs.readFile(original.localPath, 'utf8')).includes(f.suggestion.action));
    const wire = sessionContext(target, '继续', []); target.nativeId = 'n';
    target.messages.push({ id: randomUUID(), role: 'user', text: wire.text, userText: '继续', createdAt: '', context: { ...wire.context, accepted: true, nativeId: 'n' } });
    await f.wb.feedbackRecommendation(offlineProjectId, { suggestionId: f.suggestion.id, kind: 'rejected', expectedDecisionId: f.accepted.id, requestId: randomUUID() });
    assert.equal(sessionWithAvailableReferences(target, []).sources.length, 0); assert.equal(target.messages[0].text, wire.text);
    await assert.rejects(f.wb.feedbackRecommendation(offlineProjectId, f.reaction), /处理已更新/);
  } finally { await f.close(); }
});

test('legacy tracking-only links recover into next-message references and remain removed after explicit cancellation', async () => {
  const f = await fixture(); let restored: Workbench | undefined;
  try {
    await f.wb.rsi.feedback(offlineProjectId, f.reaction); assert.equal(f.session.sources.length, 0); await f.wb.close();
    restored = new Workbench(path.join(f.root, 'store'), () => {}, () => {}); await restored.store.init(); grantTestWorkspace(restored, f.root); await restored.projectSync.init();
    await restored['restoreRecommendationReferences'](); const session = restored.session(f.session.id); assert.equal(session.sources.length, 1);
    await restored['restoreRecommendationReferences'](); assert.equal(session.sources.length, 1);
    await restored.detachPendingSource(session.id, session.sources[0].id); await restored['restoreRecommendationReferences'](); assert.equal(session.sources.length, 0);
  } finally { if (restored) await restored.close(); await f.close(); }
});

test('an interrupted rejection is recovered before an old recommendation can become a new input', async () => {
  const f = await fixture();
  try {
    await f.wb.feedbackRecommendation(offlineProjectId, f.reaction);
    const save = f.wb.store.save.bind(f.wb.store); f.wb.store.save = async () => { throw Error('disk busy'); };
    await assert.rejects(f.wb.feedbackRecommendation(offlineProjectId, { suggestionId: f.suggestion.id, kind: 'rejected', requestId: randomUUID(), expectedDecisionId: f.accepted.id }), /disk busy/);
    f.wb.store.save = save;
    await f.wb['restoreRecommendationReferences'](f.session.id);
    assert.equal(sessionWithAvailableReferences(f.session, []).sources.length, 0);
  } finally { await f.close(); }
});

test('feedback retains an existing closed-session association and defers a legacy reference until reopening', async () => {
  const f = await fixture();
  try {
    await f.wb.rsi.feedback(offlineProjectId, f.reaction); await f.wb.closeSession(f.session.id);
    const result = await f.wb.feedbackRecommendation(offlineProjectId, { ...f.reaction, requestId: randomUUID(), text: '会话完成后补充评价' });
    assert.equal(result.reference?.status, 'deferred'); assert.equal(f.session.sources.length, 0);
    await f.wb.reopenSession(f.session.id); await f.wb['restoreRecommendationReferences'](f.session.id);
    assert.equal(f.session.sources.length, 1);
    await f.wb.closeSession(f.session.id);
    const ready = await f.wb.feedbackRecommendation(offlineProjectId, { ...f.reaction, requestId: randomUUID(), text: '保留已有参考，更新评价' });
    assert.equal(ready.reference?.status, 'ready'); assert.equal(f.session.sources.length, 1);
  } finally { await f.close(); }
});

test('CLI receives a linked recommendation on the next turn once, including a link made while generating', async () => {
  const f = await fixture();
  try {
    const cliRoot = path.join(f.root, 'cli'), cli = await authLauncher(cliRoot, { status: 'ready', turn: 'hang' });
    f.wb.store.settings.providerPaths.codex = cli.launcher; f.wb.store.settings.codexRequestGuard = false;
    await f.wb.send(f.session.id, '先处理当前任务');
    const before = structuredClone(f.session.messages); await f.wb.feedbackRecommendation(offlineProjectId, f.reaction);
    assert.deepEqual(f.session.messages, before); const source = f.session.sources[0];
    await f.wb.steer(f.session.id, 'fake-turn', '保持当前轮的要求', [source.id]);
    const calls = async () => (await fs.readFile(path.join(cliRoot, 'rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert(!(await calls()).find(call => call.method === 'turn/steer').params.input[0].text.includes('rsi-recommendation:'));
    assert(!sourceWasAccepted(f.session, source));
    await f.wb.stop(f.session.id); await cli.write({ status: 'ready', turn: 'success' });
    await f.wb.send(f.session.id, '现在检查下一步');
    const request = (await calls()).filter(call => call.method === 'turn/start').at(-1).params.input[0].text;
    assert(request.includes(source.sourcePath)); assert(request.includes(source.localPath));
    assert(sourceWasAccepted(f.session, source));
    assert(!sessionContext(f.session, '再继续', []).sources.some(item => item.id === source.id));
    await assert.rejects(f.wb.detachPendingSource(f.session.id, source.id), /已发送给模型|正在提交/);
  } finally { await f.close(); }
});
