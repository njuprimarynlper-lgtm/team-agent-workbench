import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { sessionContext } from '../src/core/session-context';
import { preparationSnapshot } from '../src/core/preparation-snapshot';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import { accountIdentity } from '../src/shared/account-data';

test('Beta selection is off by default and isolated by team account', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-session-handoff-beta-'));
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const alice = wb.store.settings.workspaceSnapshot!.profile;
    assert.equal(wb.betaFeatureEnabled('sessionHandoff'), false);
    await wb.setBetaFeature('sessionHandoff', true);
    assert.equal(wb.betaFeatureEnabled('sessionHandoff'), true);
    const bob = { ...alice, username: 'bob' };
    wb.store.settings.workspaceSnapshot!.profile = bob;
    assert.equal(wb.betaFeatureEnabled('sessionHandoff'), false);
    assert.deepEqual(Object.keys(wb.snapshot().settings.betaFeatures || {}), []);
    await wb.setBetaFeature('sessionHandoff', true);
    assert.deepEqual(Object.keys(wb.snapshot().settings.betaFeatures || {}), [accountIdentity(bob)]);
    wb.store.settings.workspaceSnapshot!.profile = alice;
    assert.deepEqual(Object.keys(wb.snapshot().settings.betaFeatures || {}), [accountIdentity(alice)]);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('same-project sessions can explicitly attach frozen stage summaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-session-handoff-'));
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const source = await wb.createSession('codex', root, offlineProjectId);
    const target = await wb.createSession('cursor', root, offlineProjectId);
    await wb.saveHandoff(source.id, '# 阶段摘要\n\n## 当前进展\n完成接口草案。\n\n## 下一步\n验证调用方。');
    assert.equal(wb.betaFeatureEnabled('sessionHandoff'), false);
    await assert.rejects(wb.listSessionHandoffs(target.id), /Beta 功能/);
    await wb.setBetaFeature('sessionHandoff', true);
    assert.equal(wb.betaFeatureEnabled('sessionHandoff'), true);
    const [option] = await wb.listSessionHandoffs(target.id);
    assert.equal(option.id, source.id);
    assert.match(option.text, /完成接口草案/);
    target.autoUpload = true;
    const first = await wb.attachSessionHandoff(target.id, source.id, option.sha256);
    assert.equal(target.autoUpload, false, 'personal handoff turns off automatic team trajectory upload');
    assert.equal(await wb.archive(target.id, true), undefined);
    assert.equal(wb.store.transfers.length, 0);
    assert.equal(first.sourcePath, 'session-handoff:' + source.id);
    assert.match(await fs.readFile(first.localPath, 'utf8'), /完成接口草案/);
    assert.equal((await wb.attachSessionHandoff(target.id, source.id, option.sha256)).id, first.id, 'unchanged summaries reuse their snapshot');
    assert.equal(target.sources.length, 1);
    assert.equal(sessionContext(target, '继续验证', []).sources.length, 0, 'attaching alone does not send to the model');
    assert.deepEqual(sessionContext(target, '继续验证', [first.id]).sources.map(item => item.id), [first.id]);
    const beforePreparation = await preparationSnapshot(target, path.join(root, 'prepare-before'));
    assert(!beforePreparation.files.some(item => item.sourcePath === first.sourcePath), 'personal handoff is not an input to team result preparation');
    await wb.saveHandoff(source.id, '# 阶段摘要\n\n## 当前进展\n验证完成。');
    assert.match(await fs.readFile(first.localPath, 'utf8'), /完成接口草案/, 'previous snapshot remains frozen');
    await assert.rejects(wb.attachSessionHandoff(target.id, source.id, option.sha256), /已更新/);
    const [updated] = await wb.listSessionHandoffs(target.id);
    const second = await wb.attachSessionHandoff(target.id, source.id, updated.sha256);
    assert.notEqual(second.id, first.id);
    assert.match(await fs.readFile(second.localPath, 'utf8'), /验证完成/);
    await wb.detachPendingSource(target.id, first.id);
    assert.equal(target.sources.length, 1);
    assert.equal(target.sources[0].id, second.id);
    target.messages.push({ id: randomUUID(), role: 'user', text: '继续验证', createdAt: new Date().toISOString(), context: { nativeId: 'native', accepted: true, workRecord: false, sourceHashes: { [second.id]: second.sha256 } } });
    const afterPreparation = await preparationSnapshot(target, path.join(root, 'prepare-after'));
    assert(!afterPreparation.files.some(item => item.sourcePath === second.sourcePath), 'even a used personal handoff stays out of result preparation');
    await wb.saveHandoff(source.id, 'X'.repeat(128 * 1024 + 1));
    const [tooLarge] = await wb.listSessionHandoffs(target.id);
    assert.match(tooLarge.error, /128 KB/);
    await assert.rejects(wb.attachSessionHandoff(target.id, source.id, tooLarge.sha256), /128 KB/);
    await wb.setBetaFeature('sessionHandoff', false);
    await assert.rejects(wb.listSessionHandoffs(target.id), /Beta 功能/);
    await assert.rejects(wb.attachSessionHandoff(target.id, source.id, updated.sha256), /Beta 功能/);
    assert.equal(target.sources.length, 1, 'disabling Beta preserves existing snapshots');
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('cross-project, cross-account, closed-target and self handoffs are rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-session-handoff-scope-'));
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    await wb.setBetaFeature('sessionHandoff', true);
    const source = await wb.createSession('codex', root, offlineProjectId);
    const otherProjectId = 'project_' + 'b'.repeat(32);
    wb.store.settings.workspaceSnapshot!.profile.projects.push({ ...source.binding!.project, id: otherProjectId, name: '另一项目' });
    const otherProject = await wb.createSession('codex', root, otherProjectId);
    const option = (await wb.listSessionHandoffs(otherProject.id));
    assert.equal(option.length, 0);
    const hash = (await wb.listSessionHandoffs((await wb.createSession('cursor', root, offlineProjectId)).id))[0].sha256;
    await assert.rejects(wb.attachSessionHandoff(otherProject.id, source.id, hash), /同一账号、同一项目/);
    await assert.rejects(wb.attachSessionHandoff(source.id, source.id, hash), /同一账号、同一项目/);
    const foreign = { ...source, id: randomUUID(), binding: { ...source.binding!, username: 'bob' } };
    wb.store.sessions.push(foreign);
    assert(!(await wb.listSessionHandoffs(source.id)).some(item => item.id === foreign.id));
    await assert.rejects(wb.attachSessionHandoff(source.id, foreign.id, hash), /不属于当前账号/);
    await wb.closeSession(otherProject.id);
    await assert.rejects(wb.attachSessionHandoff(otherProject.id, source.id, hash), /未关闭/);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});
