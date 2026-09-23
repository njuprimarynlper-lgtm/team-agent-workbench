import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { teamResultDifference } from '../src/shared/team-result-difference';
import { accountIdentity } from '../src/shared/account-data';
import type { SharedContent } from '../src/shared/content';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

const now = '2026-09-23T04:00:00Z';
const remoteResult = (): SharedContent => ({ id: randomUUID(), title: '团队结论', description: '完成验证后的团队结论。', kind: 'contribution', category: 'finding', revision: 1, state: 'submitted', author: 'alice', updatedBy: 'alice', createdAt: now, updatedAt: now, path: '/projects/test/result.md', sha256: 'a'.repeat(64), size: 64 });
async function fixture(run: (wb: Workbench, items: SharedContent[], root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-result-diff-')), wb = new Workbench(root, () => {}, () => {}), items = [remoteResult()];
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    wb.remote.binding = () => { const p = wb.store.settings.workspaceSnapshot!.profile; return { connectionId: p.id, host: p.host, port: p.port, username: p.username, fingerprint: p.fingerprint, project: p.projects[0] }; };
    wb.remote.contentList = async () => structuredClone(items);
    wb.store.settings.contentUpdates = [{ eventId: 'event', projectId: offlineProjectId, projectName: '项目', id: items[0].id, title: items[0].title, revision: 1, change: 'new', occurredAt: now, detectedAt: now }];
    await run(wb, items, root);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
}
const difference = (wb: Workbench, item: SharedContent) => teamResultDifference(item, wb.conclusions(offlineProjectId, true));

test('copy, duplicate clicks, personal deletion, reimport and restart derive visibility from current copies', async () => fixture(async (wb, items, root) => {
  const item = items[0]; assert.equal(difference(wb, item), 'missing');
  await wb.markContentUpdates(['event']); assert.equal(difference(wb, item), 'missing', 'processed activity is not a personal copy');
  const results = await Promise.all([1, 2, 3].map(() => wb.importContentConclusion(offlineProjectId, item.id, 1)));
  assert.equal(new Set(results.map(result => result.conclusion.id)).size, 1); assert.equal(wb.conclusions(offlineProjectId).length, 1);
  assert.equal(difference(wb, item), undefined);
  assert.equal(difference(wb, { ...item, id: randomUUID() }), 'missing', 'identical text from another origin remains distinct');
  const local = results[0].conclusion;
  await wb.archiveConclusion(local.id, true); assert.equal(difference(wb, item), undefined, 'history still owns a copy');
  await wb.deleteConclusion(local.id, local.version); assert.equal(difference(wb, item), 'missing');
  const adopted = await wb.importContentConclusion(offlineProjectId, item.id, 1);
  assert.notEqual(adopted.conclusion.id, local.id); assert.equal(difference(wb, item), undefined);
  const restored = new Store(root); await restored.init();
  assert.equal(teamResultDifference(item, restored.conclusions), undefined); assert(restored.conclusions.find(value => value.id === local.id)?.deletedAt);
}));

test('remote deletion keeps personal copies and remote reappearance is compared against what is still owned', async () => fixture(async (wb, items) => {
  const item = items[0], local = (await wb.importContentConclusion(offlineProjectId, item.id, 1)).conclusion;
  const before = structuredClone(local); items.splice(0);
  await assert.rejects(wb.importContentConclusion(offlineProjectId, item.id, 1), /已删除/);
  assert.deepEqual(wb.conclusions(offlineProjectId), [before]);
  items.push(item); assert.equal(difference(wb, item), undefined);
  items.splice(0); await wb.deleteConclusion(local.id, local.version);
  assert.equal(wb.conclusions(offlineProjectId, true).length, 0);
  items.push(item); assert.equal(difference(wb, item), 'missing');
}));

test('team updates and personal edits remain independent, preserving rewritten text and frozen session references', async () => fixture(async (wb, items, root) => {
  const item = items[0], local = (await wb.importContentConclusion(offlineProjectId, item.id, 1)).conclusion;
  const session = await wb.createSession('codex', root, offlineProjectId), frozen = await wb.attachConclusion(session.id, local.id);
  const originalReference = await fs.readFile(frozen.localPath, 'utf8');
  await wb.saveConclusionAlias(local.id, '我的简称'); assert.equal(difference(wb, item), undefined);
  await wb.saveConclusion(local.id, local.title, '我补充的独立分析'); assert.equal(difference(wb, item), 'edited');
  const copy = (await wb.importContentConclusion(offlineProjectId, item.id, 1)).conclusion;
  assert.notEqual(copy.id, local.id); assert.equal(local.content, '我补充的独立分析'); assert.equal(difference(wb, item), undefined);
  assert.equal((await wb.importContentConclusion(offlineProjectId, item.id, 1)).conclusion.id, copy.id);
  item.revision++; item.description = '补充新证据后的第二版。'; item.sha256 = 'b'.repeat(64);
  assert.equal(difference(wb, item), 'updated');
  const updated = await wb.importContentConclusion(offlineProjectId, item.id, 2);
  assert.equal(updated.conclusion.id, copy.id); assert.equal(local.content, '我补充的独立分析'); assert.equal(difference(wb, item), undefined);
  await wb.deleteConclusion(copy.id, copy.version); assert.equal(difference(wb, item), 'updated');
  assert.equal(await fs.readFile(frozen.localPath, 'utf8'), originalReference);
}));

test('stale versions and failed import or deletion persistence do not claim a completed transfer', async () => fixture(async (wb, items) => {
  const item = items[0], save = wb.store.save.bind(wb.store);
  wb.store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(wb.importContentConclusion(offlineProjectId, item.id, 1), /disk full/);
  assert.equal(difference(wb, item), 'missing'); assert.equal(wb.contentUpdates()[0].readAt, undefined);
  wb.store.save = save;
  const local = (await wb.importContentConclusion(offlineProjectId, item.id, 1)).conclusion, before = structuredClone(local);
  item.revision = 2; item.description = '第二版';
  await assert.rejects(wb.importContentConclusion(offlineProjectId, item.id, 1), /已更新/);
  wb.store.save = async () => { throw new Error('disk full'); };
  try {
    await assert.rejects(wb.importContentConclusion(offlineProjectId, item.id, 2), /disk full/); assert.deepEqual(local, before);
    await assert.rejects(wb.deleteConclusion(local.id, local.version), /disk full/); assert.deepEqual(local, before);
  } finally { wb.store.save = save; }
  assert.equal(difference(wb, item), 'updated');
}));

test('account switching during remote fetch rejects the import and another account cannot hide or delete the prior account copy', async () => fixture(async (wb, items) => {
  const item = items[0], profile = wb.store.settings.workspaceSnapshot!.profile;
  const local = (await wb.importContentConclusion(offlineProjectId, item.id, 1)).conclusion;
  assert.equal(local.accountOwner, accountIdentity(profile));
  profile.username = 'bob'; assert.equal(difference(wb, item), 'missing');
  await assert.rejects(wb.deleteConclusion(local.id, local.version), /不存在/);
  wb.remote.contentList = async () => { profile.username = 'carol'; return structuredClone(items); };
  await assert.rejects(wb.importContentConclusion(offlineProjectId, item.id, 1), /账号已改变/);
  assert.equal(wb.store.conclusions.length, 1);
}));

test('file replacement hashes and source revision changes are differences even when display text is unchanged', async () => fixture(async (wb, items) => {
  const item = items[0]; item.kind = 'file'; item.description = '';
  const local = (await wb.importContentConclusion(offlineProjectId, item.id, 1)).conclusion;
  assert.equal(difference(wb, item), undefined);
  item.sha256 = 'b'.repeat(64); assert.equal(difference(wb, item), 'updated');
  await wb.importContentConclusion(offlineProjectId, item.id, 1); assert.equal(difference(wb, item), undefined);
  item.revision++; assert.equal(difference(wb, item), 'updated');
  await wb.importContentConclusion(offlineProjectId, item.id, 2); assert.equal(difference(wb, item), undefined);
  local.content = '\r\n' + local.content + '\r\n'; assert.equal(difference(wb, item), undefined);
}));
