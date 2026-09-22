import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { repairConclusionImports } from '../src/core/conclusion-import-repair';
import { conclusionTitle } from '../src/shared/conclusion-context';
import type { ContentUpdate, Draft, ProjectConclusion, RemoteBinding } from '../src/shared/types';
import type { SharedContent } from '../src/shared/content';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

const now = '2026-09-21T12:00:00.000Z';
function remote(title: string, description: string): SharedContent {
  return { id: randomUUID(), title, description, revision: 1, category: 'finding', kind: 'contribution', path: '/projects/test/result.md', author: 'alice', updatedBy: 'alice', state: 'submitted', createdAt: now, updatedAt: now, sha256: 'a'.repeat(64), size: 1 };
}
function activity(item: SharedContent): ContentUpdate {
  return { eventId: 'activity:' + item.id + ':' + item.revision, projectId: offlineProjectId, projectName: '华为算法大赛', id: item.id, title: item.title, revision: item.revision, change: 'new', occurredAt: now, detectedAt: now };
}
async function fixture(items: SharedContent[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-activity-materials-')), wb = new Workbench(root, () => {}, () => {});
  await wb.store.init(); grantTestWorkspace(wb, root);
  wb.remote.binding = () => ({ project: wb.store.settings.workspaceSnapshot!.profile.projects[0] }) as RemoteBinding;
  wb.remote.contentList = async () => structuredClone(items);
  wb.store.settings.contentUpdates = items.map(activity);
  return { wb, root, close: async () => { await wb.close(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-activity-materials-'))); await fs.rm(root, { recursive: true, force: true }); } };
}

test('saving similar or identical results with different remote IDs never groups them; only the same ID updates', async () => {
  const finding = remote('v28的V Hessian会跳过同长度后续样本且每个Q head仅采4个query', 'v28 的 V Hessian 校准跳过同长度后续样本，每个 Q head 仅采 4 个 query。'),
    risk = remote('V覆盖候选尚无PyTorch自检、MSE和耗时证据', 'V 覆盖候选尚无 PyTorch 自检、MSE 和耗时证据。'), identical = { ...finding, id: randomUUID() };
  const x = await fixture([finding, risk, identical]);
  try {
    const combined = await x.wb.createConclusion(offlineProjectId, '【项目结论】 v28 校准缺陷与 v29 候选结论', finding.description + '\n' + risk.description);
    const before = structuredClone(combined);
    const a = await x.wb.importContentConclusion(offlineProjectId, finding.id, 1), b = await x.wb.importContentConclusion(offlineProjectId, risk.id, 1), c = await x.wb.importContentConclusion(offlineProjectId, identical.id, 1);
    assert.equal(a.action, 'created'); assert.equal(b.action, 'created'); assert.equal(c.action, 'created');
    assert.equal(new Set([combined.id, a.conclusion.id, b.conclusion.id, c.conclusion.id]).size, 4);
    assert.equal(a.conclusion.content, finding.description); assert.equal(b.conclusion.content, risk.description);
    assert.deepEqual(combined, before);
    for (const [item, result] of [[finding, a], [risk, b], [identical, c]] as const) {
      const event = x.wb.contentUpdates().find(event => event.id === item.id)!;
      assert.equal(event.actions?.[0].targetId, result.conclusion.id);
      assert.equal(event.actions?.[0].targetTitle, conclusionTitle(result.conclusion));
      assert.equal(event.actions?.[0].sourceTitle, item.title);
    }
    assert.equal((await x.wb.importContentConclusion(offlineProjectId, finding.id, 1)).action, 'duplicate');
    assert.equal(x.wb.conclusions(offlineProjectId).length, 4);
    finding.revision = 2; finding.title = 'v28 同长度样本校准检查'; finding.description = '已补充第二份同长度样本的检查。';
    const revised = await x.wb.importContentConclusion(offlineProjectId, finding.id, 2);
    assert.equal(revised.conclusion.id, a.conclusion.id); assert.equal(revised.action, 'updated');
    assert.equal(revised.conclusion.content, finding.description); assert.equal(c.conclusion.content, identical.description);
    await x.wb.saveConclusion(revised.conclusion.id, '用户自己维护的标题', '用户自己的分析');
    finding.revision = 3; finding.description = '远端更新不能覆盖手工修改';
    await x.wb.importContentConclusion(offlineProjectId, finding.id, 3);
    assert.equal(revised.conclusion.title, '用户自己维护的标题'); assert.equal(revised.conclusion.content, '用户自己的分析');
  } finally { await x.close(); }
});

test('stale activity imports cannot silently adopt a renamed revision or record success before confirmation', async () => {
  const item = remote('V覆盖候选尚无PyTorch自检、MSE和耗时证据', '第一版风险');
  const x = await fixture([item]);
  try {
    const original = x.wb.contentUpdates()[0];
    item.revision = 2; item.title = 'v29 Attention V覆盖候选的统一结论与验证缺口'; item.description = '第二版合并结果';
    await assert.rejects(x.wb.importContentConclusion(offlineProjectId, item.id, 1), /已更新/);
    assert.equal(x.wb.conclusions(offlineProjectId).length, 0); assert.equal(original.readAt, undefined); assert.equal(original.actions, undefined);
    const result = await x.wb.importContentConclusion(offlineProjectId, item.id, 2);
    assert.equal(result.conclusion.content, item.description);
    assert.equal(original.title, 'V覆盖候选尚无PyTorch自检、MSE和耗时证据'); assert.equal(original.revision, 1);
    const recorded = x.wb.contentUpdates()[0].actions![0];
    assert.equal(recorded.sourceRevision, 2); assert.equal(recorded.sourceTitle, item.title);
    const before = structuredClone({ items: x.wb.store.conclusions, event: original });
    item.revision = 3; item.description = '确认弹窗之后又有修改';
    await assert.rejects(x.wb.importContentConclusion(offlineProjectId, item.id, 2), /已更新/);
    assert.deepEqual({ items: x.wb.store.conclusions, event: original }, before);
  } finally { await x.close(); }
});

test('different local result IDs also remain independent when their titles and content are identical', async () => {
  const x = await fixture([]);
  try {
    const draft = { id: randomUUID(), sessionId: 'source-session', generation: 'ready', generationFinishedAt: now, binding: x.wb.remote.binding(offlineProjectId), body: '', artifacts: ['a', 'b'].map(id => ({ id, category: 'finding', title: '【项目结论】 同长度样本校准', body: '不能跳过后续同长度样本。', selected: true })) } as Draft;
    const sync = () => (x.wb as any).syncDraftConclusions(draft);
    const first = sync(); assert.equal(first.length, 2); assert.notEqual(first[0].conclusion.id, first[1].conclusion.id);
    assert.equal(x.wb.conclusions(offlineProjectId).length, 2);
    draft.artifacts![0].body = '第一条补充了新依据'; sync();
    assert.equal(x.wb.conclusions(offlineProjectId).length, 2);
    assert.equal(first[0].conclusion.content, '第一条补充了新依据'); assert.equal(first[1].conclusion.content, '不能跳过后续同长度样本。');
  } finally { await x.close(); }
});

function legacyGroup() {
  const source = remote('【项目结论】 v28的V Hessian会跳过同长度后续样本且每个Q head仅采4个query', '同长度后续样本被跳过，每个 Q head 仅采 4 个 query。');
  const merged: ProjectConclusion = { id: randomUUID(), projectId: offlineProjectId, title: '【项目结论】 v28 校准缺陷与 v29 候选结论', titleAlias: '我的统一分析', content: '这是用户确认过的综合结论，不能被导入操作覆盖。', version: 1, automatic: false, updatedAt: now, sources: [
    { id: randomUUID(), kind: 'conclusion', title: '用户选择的原结论', content: '原始证据', revision: 1, updatedAt: now },
    { id: source.id, kind: 'remote', title: source.title, content: source.description, revision: 1, updatedAt: now, path: source.path }
  ] };
  const event = activity(source); event.readAt = now; event.actions = [{ kind: 'saved_conclusion', at: now, targetId: merged.id, targetTitle: conclusionTitle(merged), sourceRevision: 1 }];
  return { merged, event, source };
}

test('legacy misgrouping is repaired once with a backup, keeping merged text, aliases, explicit merge sources and frozen Sessions', async () => {
  const x = await fixture([]);
  try {
    const { merged, event, source } = legacyGroup(); x.wb.store.conclusions.push(merged); x.wb.store.settings.contentUpdates = [event];
    const session = await x.wb.createSession('codex', x.root, offlineProjectId), frozen = await x.wb.attachConclusion(session.id, merged.id);
    const frozenText = await fs.readFile(frozen.localPath, 'utf8'), old = structuredClone(merged);
    await x.wb.close();
    const sessionsFile = await fs.readFile(path.join(x.root, 'sessions.json'), 'utf8');
    const restored = new Store(x.root); await restored.init();
    const saved = restored.conclusions.find(item => item.id === merged.id)!, recovered = restored.conclusions.find(item => item.id !== merged.id)!;
    assert.equal(saved.content, old.content); assert.equal(saved.title, old.title); assert.equal(saved.titleAlias, old.titleAlias);
    assert.deepEqual(saved.sources, [old.sources[0]]); assert.equal(saved.automatic, false);
    assert.equal(recovered.content, source.description); assert.equal(recovered.title, source.title); assert.deepEqual(recovered.sources, [old.sources[1]]);
    const action = restored.settings.contentUpdates![0].actions![0];
    assert.equal(action.targetId, recovered.id); assert.equal(action.targetTitle, recovered.title); assert.equal(action.correctedFromTitle, conclusionTitle(old));
    assert.equal(await fs.readFile(frozen.localPath, 'utf8'), frozenText);
    assert.equal(await fs.readFile(path.join(x.root, 'sessions.json'), 'utf8'), sessionsFile);
    assert.deepEqual(restored.sessions[0].sources, session.sources);
    const backups = await fs.readdir(path.join(x.root, 'migrations')); assert.equal(backups.length, 1);
    const backup = JSON.parse(await fs.readFile(path.join(x.root, 'migrations', backups[0]), 'utf8'));
    assert.deepEqual(backup.conclusions, [old]);
    const again = new Store(x.root); await again.init();
    assert.deepEqual(again.conclusions, restored.conclusions); assert.deepEqual(again.settings.contentUpdates, restored.settings.contentUpdates);
    assert.equal((await fs.readdir(path.join(x.root, 'migrations'))).length, 1);
    // Do not let fixture cleanup save its older in-memory data over this store.
    x.wb.store.conclusions = restored.conclusions; x.wb.store.settings = restored.settings;
  } finally { await x.close(); }
});

test('legacy recovery is deterministic and never resurrects a deleted copy or splits explicit merge snapshots', () => {
  const { merged, event } = legacyGroup();
  const a = [structuredClone(merged)], b = structuredClone(a), aEvents = [structuredClone(event)], bEvents = structuredClone(aEvents);
  assert.equal(repairConclusionImports(a, aEvents), true); assert.equal(repairConclusionImports(b, bEvents), true);
  assert.deepEqual(a, b); assert.deepEqual(aEvents, bEvents); assert.equal(repairConclusionImports(a, aEvents), false);
  const removed = { ...structuredClone(a[0]), deletedAt: now, archived: true };
  const originals = [structuredClone(merged), removed], originalEvents = [structuredClone(event)];
  repairConclusionImports(originals, originalEvents);
  assert.equal(originals.length, 2); assert.equal(originals[1].deletedAt, now); assert.equal(originalEvents[0].actions![0].targetId, merged.id);
  const explicit = structuredClone(merged); explicit.sources[1].kind = 'conclusion';
  const before = structuredClone(explicit); repairConclusionImports([explicit], [structuredClone(event)]); assert.deepEqual(explicit, before);
});

test('activity history distinguishes the original revision from the actually imported result without opening windows', async () => {
  const { ContentActionRecord, UpdatedContentConfirmation } = await import('../src/renderer/content-updates');
  const item = remote('旧版风险标题', '旧内容'), event = activity(item);
  const action = { kind: 'saved_conclusion' as const, targetTitle: '更新后的综合结论', sourceTitle: '更新后的综合结论', sourceRevision: 2, at: now };
  const html = renderToStaticMarkup(createElement(ContentActionRecord, { event, action }));
  assert.match(html, /已加入更新后的成果/); assert.match(html, /更新后的综合结论/); assert.match(html, /第 2 版/); assert.match(html, /此动态记录的是第 1 版/);
  const modal = renderToStaticMarkup(createElement(UpdatedContentConfirmation, { original: event, latest: { ...event, title: '更新后的综合结论', revision: 2 }, busy: false, confirm: () => {}, close: () => {}, view: () => {} }));
  assert.match(modal, /旧版风险标题/); assert.match(modal, /更新后的综合结论/); assert.match(modal, /将第 2 版存为项目笔记/);
  const repaired = renderToStaticMarkup(createElement(ContentActionRecord, { event, action: { ...action, sourceRevision: 1, correctedFromTitle: '曾被误归入的资料' } }));
  assert.match(repaired, /已纠正旧版自动归并/); assert.match(repaired, /已恢复为独立笔记/); assert.doesNotMatch(repaired, /已加入更新后的成果/);
});
