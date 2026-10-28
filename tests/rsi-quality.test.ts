import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RsiEngine, type RsiHost } from '../src/core/rsi';
import { policyBundle, policyPrompt } from '../src/core/rsi-prompts';
import { presentationPrompt, validatePresentations } from '../src/core/rsi-presentation-review';
import { reviewRecommendations, validateValueVerdicts, valueApproved, valueJudgePrompt } from '../src/core/rsi-value-review';
import { rsiDefaultRules, type RsiAnswer, type RsiEvidence, type RsiPolicy, type RsiValueCandidate } from '../src/shared/rsi';
import { passingValueReview } from './fixtures/rsi-value-review';
import { backgroundAnswer } from '../src/core/background-text';

const field = (prompt: string, name: string) => JSON.parse(prompt.split('\n').find(line => line.startsWith(name + '='))!.slice(name.length + 1));
const evidence = [{ id: 'a', text: '连续三轮失败，尚未定位原因。请帮助判断下一步。' }] as RsiEvidence[];
const policy: RsiPolicy = { id: 'p', createdAt: '', evidenceIds: [], hypothesis: '', status: 'active', scope: 'user-project', rules: rsiDefaultRules, bundle: policyBundle() };
const suggestion = { title: '尾部误差连续三轮超标，整体均值不能定位失败样本', action: '按输入幅值分桶检查误差，再决定调整范围或舍入规则。', reason: 'HIDDEN_JUSTIFICATION', conditions: ['HIDDEN_CONDITION'], uncertainty: 'HIDDEN_UNCERTAINTY', evidenceIds: ['a'], priority: .7 };
const candidate: RsiValueCandidate = { candidateId: 'candidate-1', suggestion };
const answer: RsiAnswer = { state: { progress: '', blockers: [], unknowns: [], evidenceIds: [] }, suggestions: [suggestion], sessionStates: [] };
const reference = JSON.stringify({ evidence, projectBackground: 'SHARED_BACKGROUND' });

test('background JSON uses the final answer without concatenating commentary or superseded partials', () => {
  const message = (text: string, phase?: 'commentary' | 'final_answer') => ({ id: text, role: 'assistant' as const, text, phase, createdAt: '' });
  assert.equal(backgroundAnswer([message('{"verdicts": [', 'commentary'), message('{"verdicts": []}', 'final_answer')]), '{"verdicts": []}');
  assert.equal(backgroundAnswer([message('{"candidateId', 'final_answer'), message('{"verdicts": []}', 'final_answer')]), '{"verdicts": []}');
  assert.equal(backgroundAnswer([message('{"verdicts": []}')]), '{"verdicts": []}');
  assert.equal(backgroundAnswer([message('还在分析', 'commentary')]), '');
});

test('both review phases receive the generator frozen reference and independently assess the visible card', () => {
  const judge = valueJudgePrompt(reference, [candidate]), display = presentationPrompt(reference, [candidate]);
  assert.deepEqual(field(judge, 'REFERENCE_DATA'), JSON.parse(reference));
  assert.equal(field(policyPrompt(policy, reference), 'REFERENCE_DATA').evidence[0].text, evidence[0].text);
  for (const hidden of ['HIDDEN_JUSTIFICATION', 'HIDDEN_CONDITION', 'HIDDEN_UNCERTAINTY']) { assert(!judge.includes(hidden)); assert(!display.includes(hidden)); }
  assert.equal(display.slice(display.lastIndexOf('\nREFERENCE_DATA=') + '\nREFERENCE_DATA='.length), reference);
  assert.deepEqual(field(display, 'REFERENCE_DATA'), field(judge, 'REFERENCE_DATA'));
  assert(display.includes('SHARED_BACKGROUND'));
  assert.deepEqual(field(display, 'DISPLAY_DATA'), [{ candidateId: candidate.candidateId, title: suggestion.title, action: suggestion.action }]);
});

test('all review and revision calls preserve partial coverage, cross-session memory and both kinds of feedback byte for byte', async () => {
  const frozen = JSON.stringify({ project: { goals: '保留项目目标', preference: '先说明当前缺少什么' }, evidence,
    sessions: [{ sessionId: 'a', summary: '精度排查', evidenceIds: ['a'] }, { sessionId: 'b', summary: '独立测速', evidenceIds: [] }],
    coverage: { partial: true, remainingSources: 2 },
    priorRecommendations: [{ id: 'old', feedback: [{ kind: 'rejected', feedbackTarget: 'recommendation', text: '不要重复现有路径' }] }],
    machineReviewFeedback: [{ reason: '原文缺少介入依据', correction: '先核对最新进展', truncated: true }],
  });
  const original = policyPrompt(policy, frozen), calls: string[] = [];
  let first = true;
  await reviewRecommendations({ answer, policy, reference: frozen, evidence, call: async (prompt, purpose) => {
    calls.push(prompt);
    if (purpose === 'revise') return JSON.stringify({ revisions: [{ candidateId: candidate.candidateId, suggestion }] });
    const output = JSON.parse(passingValueReview(prompt)!);
    if (purpose === 'presentation' && first) { first = false; Object.assign(output.readings[0], { status: 'fail', correction: '明确动作对象' }); }
    return JSON.stringify(output);
  } });
  assert.equal(calls.length, 4);
  const suffix = (prompt: string) => prompt.slice(prompt.lastIndexOf('\nREFERENCE_DATA=') + '\nREFERENCE_DATA='.length);
  for (const prompt of calls) assert.equal(suffix(prompt), suffix(original));
  assert.notDeepEqual(field(calls[0], 'TASK_CONTRACT'), field(original, 'TASK_CONTRACT'));
});

for (const problem of ['fabricated-quote', 'unsupported-reference', 'foreign-span', 'skipped-span', 'missing-progress']) test(`grounding rejects ${problem}`, () => {
  const raw = JSON.parse(passingValueReview(valueJudgePrompt(reference, [candidate]))!), verdict = raw.verdicts[0];
  if (problem === 'fabricated-quote') verdict.need.support[0].quote = '用户已经完成了全部任务';
  if (problem === 'unsupported-reference') verdict.need.support = [];
  if (problem === 'foreign-span') verdict.need.support[0].evidenceId = 'missing';
  if (problem === 'skipped-span') { verdict.difficulty.status = 'fail'; verdict.need.status = 'not_evaluated'; verdict.need.evidenceIds = []; }
  if (problem === 'missing-progress') delete verdict.currentProgress;
  assert.throws(() => validateValueVerdicts(raw, [candidate], evidence));
});

test('three passing gates without a separately approved reading cannot publish', () => {
  const verdict = validateValueVerdicts(JSON.parse(passingValueReview(valueJudgePrompt(reference, [candidate]))!), [candidate], evidence)[0];
  assert.equal(valueApproved(verdict), false);
  const raw = JSON.parse(passingValueReview(presentationPrompt(reference, [candidate]))!);
  raw.readings[0].problem = '';
  assert.throws(() => validatePresentations(raw, [candidate]), /缺少/);
});

for (const success of [false, true]) test(`unreadable card is revised once and judged again; second reading ${success ? 'passes' : 'fails'}`, async () => {
  const calls: string[] = []; let readings = 0;
  const result = await reviewRecommendations({ answer, policy, reference, evidence, call: async (prompt, purpose) => {
    calls.push(prompt);
    if (purpose === 'presentation') {
      const output = JSON.parse(passingValueReview(prompt)!); readings++;
      if (!success || readings === 1) Object.assign(output.readings[0], { status: 'fail', reason: '展示正文只说明查找动作，没有说明它如何帮助当前判断。', correction: '补充动作所支持的判断，勿补造事实。' });
      return JSON.stringify(output);
    }
    if (purpose === 'revise') {
      assert.equal(field(prompt, 'REVIEW_DATA')[0].presentation.status, 'fail');
      return JSON.stringify({ revisions: [{ candidateId: candidate.candidateId, suggestion: { ...suggestion, action: '按幅值分桶对齐误差，用失败样本分布区分范围不足和舍入偏差。' } }] });
    }
    return passingValueReview(prompt)!;
  } });
  assert.equal(calls.length, success ? 4 : 3); assert.equal(result.suggestions.length, success ? 1 : 0);
  assert.equal(result.feedback.length, 2); assert.equal(result.feedback[0].verdict.presentation!.status, 'fail');
  assert.equal(result.feedback[0].verdict.difficulty.status, 'not_evaluated');
  assert(calls[0].startsWith('RSI_PROTOCOL_V2:value-presentation'));
  assert(calls[1].startsWith('RSI_PROTOCOL_V2:value-revise'));
  assert(calls.every(p => p.slice(p.lastIndexOf('\nREFERENCE_DATA=') + '\nREFERENCE_DATA='.length) === reference));
});

test('malformed display check fails closed instead of relying on value approval', async () => {
  await assert.rejects(reviewRecommendations({ answer, policy, reference, evidence, call: async (prompt, purpose) => purpose === 'presentation' ? '{"readings":[]}' : passingValueReview(prompt)! }), /完整覆盖/);
});

test('first-gate feedback reaches the next generator with its reason and correction, without becoming user feedback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsi-reading-feedback-'));
  let nextInput: any; let generation = 0;
  const engine = new RsiEngine(root, {
    scope: projectId => ({ key: projectId, projectId, account: 'alice', user: 'alice' }),
    execution: () => ({ id: 'background', provider: 'codex', model: 'stub', purpose: 'background', title: '', cwd: root, status: 'idle', messages: [], sources: [], approvals: [], autoUpload: false, handoffPath: '', createdAt: '' }),
    session: () => undefined, changed() {}, collect: async () => [{ source: 'session', sourceId: 'a', factKey: 'a', text: evidence[0].text, version: '1', eventAt: new Date().toISOString(), assertion: 'explicit', actor: 'alice' }],
  }, async (_s, prompt) => {
    if (prompt.startsWith('RSI_PROTOCOL_V2:value-presentation')) return JSON.stringify({ readings: [{ candidateId: 'candidate-1', status: 'fail', problem: '', action: '查找', benefit: '', reason: '去向没有明确对象', correction: '说明什么对象完成什么动作后缺少哪个入口' }] });
    if (prompt.startsWith('RSI_PROTOCOL_V2:value-revise')) {
      assert.equal(field(prompt, 'REVIEW_DATA')[0].difficulty.status, 'not_evaluated');
      return JSON.stringify({ revisions: [{ candidateId: 'candidate-1', suggestion: null }] });
    }
    assert(!prompt.startsWith('RSI_PROTOCOL_V2:value-judge'));
    nextInput = field(prompt, 'REFERENCE_DATA');
    return JSON.stringify({ ...answer, suggestions: ++generation === 1 ? [{ ...suggestion, evidenceIds: nextInput.evidence.map((item: any) => item.id) }] : [] });
  }, { debounceMs: 60000, retryMs: 60000 });
  try {
    await engine.start('p', 'recommend'); await engine.settled();
    const first = await engine.view('p'); assert.equal(first.lastError, undefined); assert.equal(first.suggestions.length, 0);
    assert.equal(first.valueFeedback![0].verdict.presentation!.status, 'fail');
    await engine.start('p', 'recommend'); await engine.settled();
    const feedback = nextInput.machineReviewFeedback[0];
    assert.equal(feedback.stages.readability, 'fail'); assert.equal(feedback.stages.difficulty, 'not_evaluated');
    assert.equal(feedback.reason, '去向没有明确对象'); assert.match(feedback.correction, /哪个入口/);
    assert.equal((await engine.view('p')).events.length, 0);
  } finally { await engine.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('quality upgrade preserves learned policy, sources and decisions, retires only old pending cards and regenerates with the current contract', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsi-quality-upgrade-'));
  const host: RsiHost = {
    scope: projectId => ({ key: projectId, projectId, account: 'alice', user: 'alice' }),
    execution: () => ({ id: 'background', provider: 'codex', model: 'stub', purpose: 'background', title: '', cwd: root, status: 'idle', messages: [], sources: [], approvals: [], autoUpload: false, handoffPath: '', createdAt: '' }),
    session: () => undefined, changed() {}, collect: async () => [{ source: 'session', sourceId: 'a', sessionId: 'A', factKey: 'a', text: evidence[0].text, version: '1', eventAt: new Date().toISOString(), assertion: 'explicit', actor: 'alice' }],
  };
  const calls: string[] = [];
  const respond = async (_session: unknown, prompt: string) => {
    calls.push(prompt);
    if (passingValueReview(prompt)) return passingValueReview(prompt)!;
    const data = field(prompt, 'REFERENCE_DATA');
    return JSON.stringify({ ...answer, suggestions: [{ ...suggestion, evidenceIds: data.evidence.map((s: any) => s.id) }] });
  };
  const engine = new RsiEngine(root, host, respond, { debounceMs: 60000, retryMs: 60000 });
  let restored: RsiEngine | undefined;
  try {
    await engine.start('p', 'recommend'); await engine.settled();
    let view = await engine.view('p'); const accepted = view.suggestions[0]; assert(accepted);
    await engine.feedback('p', { suggestionId: accepted.id, kind: 'accepted', text: '表述需要更具体', requestId: 'accepted' });
    await engine.close();
    const file = path.join(root, 'rsi-v2.json'), saved = JSON.parse(await fs.readFile(file, 'utf8')), prior = saved.projects.p;
    prior.policies[0].rules.guidance = '保留项目学到的特定偏好';
    prior.policies[0].bundle.prompt = 'LEGACY_TEMPLATE';
    prior.suggestions.push({ ...accepted, id: 'old-pending', fingerprint: 'distinct-legacy-pending' });
    prior.runs[0].suggestions.push('old-pending'); prior.runs[0].valueReview.contract = 'value-v1';
    await fs.writeFile(file, JSON.stringify(saved));
    restored = new RsiEngine(root, host, respond, { debounceMs: 60000, retryMs: 60000 });
    view = await restored.view('p');
    assert.equal(view.suggestions.length, 2); assert.deepEqual(view.events, prior.events); assert.deepEqual(view.memory, prior.memory);
    assert.equal(view.policies[0].bundle!.prompt, 'LEGACY_TEMPLATE'); assert.equal(view.qualityRefreshPending, true);
    assert.equal((await restored.inbox('p')).items.length, 1); // Accepted feedback form remains.
    await assert.rejects(restored.feedback('p', { suggestionId: 'old-pending', kind: 'accepted', requestId: 'stale' }), /推荐/);
    await restored.start('p', 'recommend', 'quality-upgrade'); await restored.settled();
    view = await restored.view('p'); assert.equal(view.lastError, undefined); assert.equal(view.qualityRefreshPending, false);
    const prompt = view.runs.at(-1)!.snapshot!.prompt!;
    assert.equal(field(prompt, 'TASK_CONTRACT').revision, 'recommend-v5');
    assert.equal(field(prompt, 'POLICY_DATA').guidance, '保留项目学到的特定偏好');
    assert(!field(prompt, 'REFERENCE_DATA').priorRecommendations.some((item: any) => item.id === 'old-pending'));
    assert.equal(view.policies[0].bundle!.prompt, 'LEGACY_TEMPLATE'); assert.deepEqual(view.events, prior.events);
    assert(!view.suggestions.find(item => item.id === accepted.id)!.supersededByQuality);
    assert.equal(view.runs.at(-1)!.valueReview!.contract, 'value-v2');
    await restored.close();
    restored = new RsiEngine(root, host, respond, { debounceMs: 60000, retryMs: 60000 });
    assert.equal((await restored.view('p')).qualityRefreshPending, false);
  } finally { await engine.close(); await restored?.close(); await fs.rm(root, { recursive: true, force: true }); }
});
