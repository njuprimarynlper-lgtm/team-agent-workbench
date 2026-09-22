import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { contributionCategoryInfo, materialCategories } from '../src/shared/content';
import { activeResultCombination, resultCategoryBoundaries, resultPreferencesSchema, resultPresets, resultRulesPrompt } from '../src/shared/result-rules';
import { applyPreparation } from '../src/core/preparation';
import { applyContentMerge } from '../src/core/content-merge';
import { containsLocalEnvironmentError } from '../src/core/preparation-policy';
import { preparationPrompt } from '../src/core/preparation-prompt';
import { Store } from '../src/core/store';
import { Workbench } from '../src/core/workbench';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import type { Draft, RemoteBinding } from '../src/shared/types';
// @ts-expect-error JS protocol fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

const binding: RemoteBinding = { connectionId: 'c', host: 'local', port: 22, username: 'alice', fingerprint: 'f', project: { id: 'p', name: '项目', remoteRoot: '/p', uploadPath: '/p/submissions/alice', historyPath: '/p/trajectories/alice' } };
const draft = (): Draft => ({ id: 'draft', binding, files: [], body: '', title: '', resultRules: { contract: 2, combinationId: 'test', name: '测试', categories: [...materialCategories] }, preparationEvidenceIds: ['message:m1', 'handoff', 'file:report'] } as unknown as Draft);
const item = (extra: Record<string, unknown> = {}) => ({ category: 'verification', topic: '缓存压力测试', title: '缓存单次测试延迟降低', origin: 'project', body: '本次压力测试延迟降低 8%，只覆盖当前测试负载，尚不能证明生产环境收益。', evidenceIds: ['message:m1'], ...extra });
const output = (...artifacts: ReturnType<typeof item>[]) => JSON.stringify({ artifacts });
async function until(fn: () => boolean) { const end = Date.now() + 15000; while (!fn()) { if (Date.now() > end) throw new Error('test timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } }

test('every category has a concrete boundary; overlapping presets are personal combinations, not generation quotas', () => {
  assert.equal(materialCategories.length, 12);
  for (const category of materialCategories) {
    const boundary = resultCategoryBoundaries[category];
    assert(boundary.question && boundary.include && boundary.exclude);
    assert(contributionCategoryInfo[category].label && contributionCategoryInfo[category].folder);
  }
  assert.equal(resultPresets.length, 3);
  assert(resultPresets.every(preset => preset.categories.includes('finding')));
  const custom = { id: randomUUID(), name: '算法比赛', categories: ['finding', 'verification', 'method_exploration'] };
  const preferences = resultPreferencesSchema.parse({ combinations: [custom], projects: { project: custom.id } });
  assert.equal(activeResultCombination(preferences, 'project').name, '算法比赛');
  assert.equal(activeResultCombination(preferences, 'other').id, 'research');
  for (const invalid of [
    { combinations: [{ ...custom, categories: [] }], projects: {} },
    { combinations: [{ ...custom, categories: ['finding', 'finding'] }], projects: {} },
    { combinations: [{ ...custom, categories: ['invented'] }], projects: {} },
    { combinations: [{ ...custom, name: '算法研究' }], projects: {} },
    { combinations: [custom, custom], projects: {} },
    { combinations: [], projects: { project: custom.id } },
  ]) assert.equal(resultPreferencesSchema.safeParse(invalid).success, false);
});

test('prompt specifies topic-first classification, human-confirmed standards and a single concise body', () => {
  const value = draft(), prompt = preparationPrompt(value, []);
  assert(prompt.includes(resultRulesPrompt(materialCategories)));
  for (const rule of ['禁止按类别逐个生成', '同一主题换类别重复', '最多 5 条', '允许 0 条', '多个独立主题可以使用相同类别', '必须能引用人的明确确认', '单次测试中延迟降低 8%', '静态检查通过', '不强制小标题', '不要输出 fields', '来源详情', 'message:m1']) assert(prompt.includes(rule), rule);
  assert(!prompt.includes('只用给定的三个字段'));
  assert.match(preparationPrompt(value, [], true), /最多生成一条新成果/);
});

test('strict extraction permits zero or five independent topics, enforces limits and preserves evidence boundaries', () => {
  const value = draft(); applyPreparation(value, output()); assert.equal(value.artifacts?.length, 0); assert.equal(value.body, '');
  const five = Array.from({ length: 5 }, (_, n) => item({ topic: '问题' + n, title: '结果' + n, body: '观察结果' + n + '，仅覆盖当前测试样本。' }));
  applyPreparation(value, output(...five)); assert.equal(value.artifacts?.length, 5);
  assert.throws(() => applyPreparation(value, output(...five, item())), /最多 5/);
  for (const malformed of [item({ title: '长'.repeat(41) }), item({ body: '长'.repeat(501) }), item({ evidenceIds: [] }), item({ origin: 'unknown' })]) assert.throws(() => applyPreparation(value, output(malformed)), /精简规则/);
  assert.throws(() => applyPreparation(value, output(item({ body: '一\n\n二\n\n三\n\n四' }))), /三段/);
  assert.throws(() => applyPreparation(value, output(item({ evidenceIds: ['message:invented'] }))), /不存在的来源/);
  value.resultRules!.categories = ['finding']; assert.throws(() => applyPreparation(value, output(item())), /未启用/);
  value.resultRules!.categories = ['verification']; applyPreparation(value, output(item()));
  assert.equal(value.artifacts![0].category, 'verification'); assert.equal(value.artifacts![0].target, '/p/submissions/alice/verifications');
  assert.equal(value.artifacts![0].title, '【验证结果】 缓存单次测试延迟降低');
  assert.match(value.body, /尚不能证明生产环境收益/); assert.doesNotMatch(value.body, /^## /m);
});

test('duplicate topics across categories and duplicate titles or bodies are rejected, never keyword-merged', () => {
  const value = draft();
  assert.throws(() => applyPreparation(value, output(item(), item({ category: 'finding', title: '另一标题', body: '另一正文' }))), /同一主题/);
  assert.throws(() => applyPreparation(value, output(item(), item({ topic: '不同问题', body: '不同正文' }))), /同一主题/);
  assert.throws(() => applyPreparation(value, output(item(), item({ topic: '不同问题', title: '不同标题' }))), /同一主题/);
  applyPreparation(value, output(item(), item({ topic: '缓存数据一致性', title: '缓存读写一致性验证', body: '并发读取仍能获取最新数据，未覆盖多节点。' })));
  assert.equal(value.artifacts!.length, 2, 'shared keywords do not collapse distinct topics');
});

test('environment errors are excluded including source details, while real project defects and unverified boundaries remain', () => {
  for (const text of ['本机未安装 PyTorch，无法运行测试。', '工作机磁盘空间不足。', '登录凭证过期，重新登录后解决。', '代理连接失败。', '本地路径权限错误。', '依赖安装失败，调整版本后修复。']) {
    assert(containsLocalEnvironmentError(text), text);
    const value = draft(); applyPreparation(value, output(item({ body: text }))); assert.equal(value.artifacts!.length, 0);
    applyPreparation(value, output(item({ sourceDetails: text }))); assert.equal(value.artifacts!.length, 0);
  }
  const value = draft();
  applyPreparation(value, output(item({ origin: 'local_environment', body: '更换设置后可以继续运行。' }), item({ topic: '网络模块重试缺陷', category: 'issue', title: '重试失败后未释放连接', body: '项目重试逻辑在 ECONNRESET 分支遗漏连接释放，压力测试可复现连接泄漏，待修复。' })));
  assert.equal(value.artifacts!.length, 1); assert.equal(value.artifacts![0].category, 'issue');
  applyPreparation(value, output(item({ category: 'method_exploration', title: '按查询头拟合曲率的方法待验证', body: '候选实现已通过静态检查，尚未完成运行验证，不能确认精度或性能收益。' })));
  assert.match(value.body, /尚未完成运行验证/); assert.equal(value.artifacts!.length, 1);
});

test('merge uses the same boundaries, at most one result, and supports an empty preview without changing sources', () => {
  const value = draft(); value.mergeSources = [{ id: 'source', revision: 1, title: '来源', author: 'alice', updatedAt: 'now' }]; value.preparationEvidenceIds = ['source'];
  const result = item({ category: 'finding', evidenceIds: ['source'], sourceDetails: '原成果的验证记录，尚不覆盖跨节点。' });
  applyContentMerge(value, output(result)); assert.equal(value.resultCategory, 'finding'); assert.match(value.title, /^【项目结论】/); assert.equal(value.resultSourceDetails, '原成果的验证记录，尚不覆盖跨节点。');
  assert.throws(() => applyContentMerge(value, output(result, item({ topic: '独立主题', title: '另一项', body: '其他内容', evidenceIds: ['source'] }))), /只生成一条/);
  applyContentMerge(value, output()); assert.equal(value.body, ''); assert.equal(value.mergeSources[0].revision, 1);
});

test('personal configuration is version-checked, persists, permits manual categories and leaves existing session content frozen', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-rules-')), wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const original = wb.resultRules(offlineProjectId), combo = { id: randomUUID(), name: '客户端开发', categories: ['requirement', 'design', 'issue'] };
    await wb.saveResultRules(offlineProjectId, original.owner, original.version, { combinations: [combo], projects: { [offlineProjectId]: combo.id } });
    await assert.rejects(wb.saveResultRules(offlineProjectId, original.owner, original.version, original.preferences), /已在其他位置更新/);
    const current = wb.resultRules(offlineProjectId);
    await assert.rejects(wb.saveResultRules(offlineProjectId, 'different-owner', current.version, current.preferences), /账号已切换/);
    const material = await wb.createConclusion(offlineProjectId, '处理流程', '按需创建并释放资源。', 'design');
    assert.equal(material.title, '【设计方案】 处理流程'); assert.equal(material.category, 'design');
    await assert.rejects(wb.createConclusion(offlineProjectId, '不启用的分类', '内容', 'verification'), /启用/);
    const session = await wb.createSession('codex', root, offlineProjectId); const attached = await wb.attachConclusion(session.id, material.id);
    const context = structuredClone(session.sources), materialBefore = structuredClone(material);
    await wb.saveResultRules(offlineProjectId, current.owner, current.version, { ...current.preferences, projects: { [offlineProjectId]: 'research' } });
    assert.deepEqual(session.sources, context); assert.deepEqual(material, materialBefore); assert(attached);
    await wb.saveConclusion(material.id, '修改正文', '保留原类别也能编辑。', 'design');
    assert.equal(material.category, 'design'); assert.deepEqual(session.sources, context);
    const legacy = await wb.createConclusion(offlineProjectId, '【需求说明】 旧需求', '旧版记录');
    await wb.saveConclusion(legacy.id, '旧需求补充', '可保留未启用的旧类别。', 'requirement'); assert.equal(legacy.category, 'requirement');
    const beforeFailure = wb.resultRules(offlineProjectId), save = wb.store.save.bind(wb.store); wb.store.save = async () => { throw new Error('disk unavailable'); };
    await assert.rejects(wb.saveResultRules(offlineProjectId, beforeFailure.owner, beforeFailure.version, original.preferences), /disk unavailable/);
    wb.store.save = save; assert.deepEqual(wb.resultRules(offlineProjectId), beforeFailure);
    const restored = new Store(root); await restored.init(); assert.deepEqual(restored.settings.resultPreferences, wb.store.settings.resultPreferences);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('in-flight preparation freezes rules, later preparation uses changed selection and review category survives restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-rules-run-')), fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success', turnDelay: 600 }), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const settings = wb.resultRules(offlineProjectId), combo = { id: randomUUID(), name: '实现设计', categories: ['requirement', 'design'] };
    await wb.saveResultRules(offlineProjectId, settings.owner, settings.version, { combinations: [combo], projects: { [offlineProjectId]: combo.id } });
    const session = await wb.createSession('codex', root, offlineProjectId); await wb.saveHandoff(session.id, '用户确认需要批量编辑，方案采用版本号校验。');
    const prepared = await wb.prepare(session.id), current = wb.resultRules(offlineProjectId);
    await wb.saveResultRules(offlineProjectId, current.owner, current.version, { ...current.preferences, projects: { [offlineProjectId]: 'investigation' } });
    await until(() => prepared.generation !== 'running'); assert.equal(prepared.generation, 'ready', prepared.generationError || '');
    assert.deepEqual(prepared.resultRules!.categories, ['requirement', 'design']); assert.equal(prepared.artifacts![0].category, 'requirement');
    await wb.changeDraftCategory(prepared.id, 'design', prepared.artifacts![0].id);
    assert.equal(prepared.artifacts![0].category, 'design'); assert.match(prepared.artifacts![0].target, /\/designs$/);
    assert.equal(wb.conclusions(offlineProjectId)[0].category, 'design');
    await assert.rejects(wb.changeDraftCategory(prepared.id, 'finding', prepared.artifacts![0].id), /启用/);
    const restored = new Store(wb.store.root); await restored.init(); assert.deepEqual(restored.drafts[0].resultRules, prepared.resultRules); assert.equal(restored.drafts[0].artifacts![0].category, 'design');
    const next = await wb.reorganizePreparation(prepared.id, 'full', ['research', 'comparison']); await until(() => next.generation !== 'running');
    assert.equal(next.generation, 'ready', next.generationError || ''); assert.equal(next.resultRules!.combinationId, 'investigation');
    assert.deepEqual(next.resultRules!.categories, ['research', 'comparison']); assert.deepEqual(next.requestedCategories, ['research', 'comparison']);
    await assert.rejects(wb.reorganizePreparation(next.id, 'full', ['design']), /启用/);
    await assert.rejects(wb.reorganizePreparation(next.id, 'full', []), /至少/);
    prepared.artifacts![0].submitted = 'uploaded'; await assert.rejects(wb.changeDraftCategory(prepared.id, 'requirement', prepared.artifacts![0].id), /已提交/);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('classification settings expose presets and collapsed boundaries without administrator gating or desktop automation', async () => {
  (globalThis as any).window = { workbench: { call: async () => {} } };
  try {
    const { ResultRulesEditor } = await import('../src/renderer/result-rules');
    const initialState = { owner: 'alice', version: '1', preferences: { combinations: [], projects: {} }, combination: resultPresets[0] };
    const html = renderToStaticMarkup(createElement(ResultRulesEditor, { projectId: 'p', projectName: '示例', initialState }));
    for (const label of ['算法研究', '软件开发', '调研分析', '新建组合', '保存并用于当前项目', '本机环境故障不整理']) assert(html.includes(label));
    assert.equal((html.match(/<summary>收录边界<\/summary>/g) || []).length, 12); assert(!html.includes('<details open'));
    const main = await fs.readFile('src/renderer/main.tsx', 'utf8'); assert.match(main, /我的成果分类/); assert.doesNotMatch(main, /started\(selected, scope\)/);
  } finally { delete (globalThis as any).window; }
});
