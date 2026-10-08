import test from 'node:test';
import assert from 'node:assert/strict';
import { contributionCategoryInfo, legacyMaterialCategories } from '../src/shared/content';
import { resultRulesPrompt } from '../src/shared/result-rules';
import { applyPreparation } from '../src/core/preparation';
import { applyContentMerge } from '../src/core/content-merge';
import { containsLocalEnvironmentError } from '../src/core/preparation-policy';
import { preparationPrompt } from '../src/core/preparation-prompt';
import type { Draft, RemoteBinding } from '../src/shared/types';

const binding: RemoteBinding = { connectionId: 'c', host: 'local', port: 22, username: 'alice', fingerprint: 'f', project: { id: 'p', name: '项目', remoteRoot: '/p', uploadPath: '/p/submissions/alice', historyPath: '/p/trajectories/alice' } };
const draft = (): Draft => ({ id: 'draft', binding, files: [], body: '', title: '', resultRules: { contract: 2, categories: [...legacyMaterialCategories] }, preparationEvidenceIds: ['message:m1', 'handoff', 'file:report'] } as unknown as Draft);
const item = (extra: Record<string, unknown> = {}) => ({ category: 'verification', topic: '缓存压力测试', title: '缓存单次测试延迟降低', origin: 'project', body: '本次压力测试延迟降低 8%，只覆盖当前测试负载，尚不能证明生产环境收益。', evidenceIds: ['message:m1'], ...extra });
const output = (...artifacts: ReturnType<typeof item>[]) => JSON.stringify({ artifacts });

test('prompt specifies topic-first classification, human-confirmed standards and a single concise body', () => {
  const value = draft(), prompt = preparationPrompt(value, []);
  assert(prompt.includes(resultRulesPrompt(legacyMaterialCategories)));
  for (const rule of ['禁止按类别逐个生成', '同一主题换类别重复', '最多 5 条', '允许 0 条', '多个独立主题可以使用相同类别', '必须能引用人的明确确认', '单次测试中延迟降低 8%', '静态检查通过', '不强制小标题', '不要输出 fields', '来源详情', 'message:m1']) assert(prompt.includes(rule), rule);
  assert(!prompt.includes('只用给定的三个字段'));
  assert.match(preparationPrompt(value, [], true), /最多生成一条新成果/);
  for (const merging of [false, true]) {
    const experiencePrompt = preparationPrompt(value, [], merging);
    for (const rule of ['finding 表示项目经验', '实际尝试', '不要求形成最终定论', '区分直接观察、原因推测和复用建议', '保留反例、未验证范围及证据冲突', '尚无实践或观察依据的设想用 method_exploration', '也不为显得谨慎而模糊已验证的数据']) assert(experiencePrompt.includes(rule), rule);
    assert.doesNotMatch(experiencePrompt, /项目结论/);
  }
});

test('strict extraction permits zero or five independent topics, enforces limits and preserves evidence boundaries', () => {
  const value = draft(); applyPreparation(value, output()); assert.equal(value.artifacts?.length, 0); assert.equal(value.body, '');
  const five = Array.from({ length: 5 }, (_, n) => item({ topic: '问题' + n, title: '结果' + n, body: '观察结果' + n + '，仅覆盖当前测试样本。' }));
  applyPreparation(value, output(...five)); assert.equal(value.artifacts?.length, 5);
  assert.throws(() => applyPreparation(value, output(...five, item())), /最多 5/);
  for (const malformed of [item({ title: '长'.repeat(41) }), item({ body: '长'.repeat(501) }), item({ evidenceIds: [] }), item({ origin: 'unknown' })]) assert.throws(() => applyPreparation(value, output(malformed)), /精简规则/);
  assert.throws(() => applyPreparation(value, output(item({ body: '一\n\n二\n\n三\n\n四' }))), /三段/);
  assert.throws(() => applyPreparation(value, output(item({ evidenceIds: ['message:invented'] }))), /不存在的来源/);
  value.resultRules!.categories = ['finding']; assert.throws(() => applyPreparation(value, output(item())), /未选择/);
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
  applyContentMerge(value, output(result)); assert.equal(value.resultCategory, 'finding'); assert.match(value.title, /^【项目经验】/); assert.equal(value.resultSourceDetails, '原成果的验证记录，尚不覆盖跨节点。');
  assert.throws(() => applyContentMerge(value, output(result, item({ topic: '独立主题', title: '另一项', body: '其他内容', evidenceIds: ['source'] }))), /只生成一条/);
  applyContentMerge(value, output()); assert.equal(value.body, ''); assert.equal(value.mergeSources[0].revision, 1);
});
