import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../src/core/workbench';
import { sessionContext } from '../src/core/session-context';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import { forkWorkspace, removeForkWorkspace } from '../src/core/subsession-workspace';

test('the Subsession Beta switch gates independent children and freezes the parent boundary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-subsession-'));
  const cwd = path.join(root, 'work'); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'model.py'), 'BASE = 1\n');
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, cwd);
    const parent = await wb.createSession('codex', cwd, offlineProjectId);
    const referencePath = path.join(cwd, 'reference.md'); await fs.writeFile(referencePath, '已验证的测试条件');
    const referenceId = randomUUID(), referenceHash = createHash('sha256').update('已验证的测试条件').digest('hex');
    parent.sources.push({ id: referenceId, name: '测试条件', localPath: referencePath, sourcePath: '/project/reference.md', sha256: referenceHash, size: Buffer.byteLength('已验证的测试条件'), fetchedAt: new Date().toISOString() });
    parent.nativeId = 'parent-native';
    parent.messages.push({ id: randomUUID(), role: 'user', text: '比较两种实现', createdAt: new Date().toISOString(), context: { nativeId: 'parent-native', accepted: true, workRecord: true, sourceHashes: { [referenceId]: referenceHash } } });
    parent.messages.push({ id: randomUUID(), role: 'assistant', text: '先从精度入手。', createdAt: new Date().toISOString() });
    parent.messages.push({ id: randomUUID(), role: 'user', text: '未送达的要求', createdAt: new Date().toISOString(), context: { nativeId: 'parent-native', accepted: false, workRecord: false, sourceHashes: {} } });
    await wb.saveHandoff(parent.id, '# 阶段摘要\n\n精度问题待验证。');
    await assert.rejects(wb.forkSubsession(parent.id, '方案 A'), /Beta 功能/);
    await wb.setBetaFeature('sessionHandoff', true);
    assert.equal(wb.betaFeatureEnabled('subsessions'), false, 'cross-session references do not turn on Subsessions');
    await assert.rejects(wb.forkSubsession(parent.id, '方案 A'), /Beta 功能/);
    await wb.setBetaFeature('sessionHandoff', false);
    await wb.setBetaFeature('subsessions', true);
    assert.equal(wb.betaFeatureEnabled('sessionHandoff'), false, 'Subsessions do not turn on cross-session references');
    await assert.rejects(wb.listSessionHandoffs(parent.id), /Beta 功能/);
    const child = await wb.forkSubsession(parent.id, '方案 A');
    assert.equal(child.parentId, parent.id); assert.equal(child.fork?.parentMessageCount, 3);
    assert.equal(child.nativeId, undefined); assert.equal(child.provider, parent.provider);
    assert.notEqual(child.cwd, parent.cwd); assert.equal(await fs.readFile(path.join(child.cwd, 'model.py'), 'utf8'), 'BASE = 1\n');
    await fs.writeFile(path.join(child.cwd, 'model.py'), 'BASE = 2\n');
    assert.equal(await fs.readFile(path.join(parent.cwd, 'model.py'), 'utf8'), 'BASE = 1\n');
    const snapshot = await fs.readFile(child.sources.find(source => source.id === child.fork?.sourceId)!.localPath, 'utf8');
    assert.match(snapshot, /比较两种实现/); assert.match(snapshot, /精度问题待验证/);
    assert.doesNotMatch(snapshot, /未送达的要求/);
    parent.messages.push({ id: randomUUID(), role: 'assistant', text: '父会话后来做了另一件事', createdAt: new Date().toISOString() });
    assert.doesNotMatch(await fs.readFile(child.sources[0].localPath, 'utf8'), /父会话后来做了另一件事/);
    assert.equal(wb.store.inputs[child.id].text, '方案 A');
    assert.equal(sessionContext(child, '开始探索', []).sources.some(source => source.id === child.fork?.sourceId), true);
    assert.equal(child.fork?.inheritedSourceIds.length, 1);
    assert.equal(await fs.readFile(child.sources.find(source => source.id === child.fork?.inheritedSourceIds[0])!.localPath, 'utf8'), '已验证的测试条件');
    assert.equal(parent.sources.length, 1, 'creating a child does not inject new content into the parent');
    await wb.setBetaFeature('sessionHandoff', true);
    await wb.setBetaFeature('subsessions', false);
    await assert.rejects(wb.forkSubsession(parent.id, '方案 B'), /Beta 功能/);
    assert.equal(wb.betaFeatureEnabled('sessionHandoff'), true, 'turning off Subsessions leaves references enabled');
    assert((await wb.listSessionHandoffs(child.id)).some(item => item.id === parent.id));
    assert.equal(wb.session(child.id).id, child.id, 'turning Beta off retains the child');
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('reports are frozen versions; parent must explicitly select them before the model sees them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-subsession-report-'));
  const cwd = path.join(root, 'work'); await fs.mkdir(cwd);
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, cwd); await wb.setBetaFeature('subsessions', true);
    const parent = await wb.createSession('codex', cwd, offlineProjectId);
    const child = await wb.forkSubsession(parent.id, '量化方案');
    child.messages.push({ id: randomUUID(), role: 'assistant', text: '初测精度下降 0.2。', createdAt: new Date().toISOString() });
    await wb.saveHandoff(child.id, '# 阶段摘要\n\n方案 A 初测，尚未独立复核。');
    const preview = await wb.previewSubsessionReport(child.id);
    assert.match(preview.body, /尚未独立复核/); assert.match(preview.latestReply, /0.2/);
    await assert.rejects(wb.publishSubsessionReport(child.id, '0'.repeat(64), preview.body), /已有更新/);
    const first = await wb.publishSubsessionReport(child.id, preview.sourceHash, preview.body);
    assert.equal(first.version, 1); assert.equal(parent.sources.length, 0);
    assert.equal((await wb.publishSubsessionReport(child.id, preview.sourceHash, preview.body)).id, first.id);
    const source = await wb.attachSubsessionReport(parent.id, child.id, first.id);
    assert.equal(sessionContext(parent, '继续', []).sources.length, 0);
    assert.deepEqual(sessionContext(parent, '继续', [source.id]).sources.map(item => item.id), [source.id]);
    assert.equal((await wb.attachSubsessionReport(parent.id, child.id, first.id)).id, source.id);
    parent.autoUpload = true;
    await wb.setBetaFeature('subsessions', false);
    await assert.rejects(wb.attachSubsessionReport(parent.id, child.id, first.id), /Beta 功能/);
    assert.equal(parent.sources.length, 1);
    await wb.setBetaFeature('subsessions', true);
    await wb.saveHandoff(child.id, '# 阶段摘要\n\n方案 A 已复核。');
    child.messages.push({ id: randomUUID(), role: 'assistant', text: '复核通过。', createdAt: new Date().toISOString() });
    const next = await wb.previewSubsessionReport(child.id);
    const second = await wb.publishSubsessionReport(child.id, next.sourceHash, next.body);
    assert.equal(second.version, 2); assert.notEqual(second.id, first.id);
    assert.match(await fs.readFile(source.localPath, 'utf8'), /尚未独立复核/);
    assert.doesNotMatch(await fs.readFile(source.localPath, 'utf8'), /已复核/);
    const newer = await wb.attachSubsessionReport(parent.id, child.id, second.id);
    assert.notEqual(newer.id, source.id); assert.equal(parent.autoUpload, false);
    await wb.reviewSubsessionReport(parent.id, child.id, second.id);
    assert(child.reports?.[1].reviewedAt);
    await wb.closeSession(parent.id);
    assert.equal(wb.session(child.id).closedAt, undefined, 'closing the parent does not stop the child');
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('cross-project, wrong parent and running-turn report operations are rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-subsession-scope-'));
  const cwd = path.join(root, 'work'); await fs.mkdir(cwd);
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, cwd); await wb.setBetaFeature('subsessions', true);
    const parent = await wb.createSession('codex', cwd, offlineProjectId);
    parent.status = 'running'; await assert.rejects(wb.forkSubsession(parent.id, '不能复制半轮结果'), /当前回复结束/); parent.status = 'idle';
    const child = await wb.forkSubsession(parent.id, '精度探索');
    child.status = 'running'; await assert.rejects(wb.previewSubsessionReport(child.id), /当前回复结束/); child.status = 'idle';
    const preview = await wb.previewSubsessionReport(child.id), report = await wb.publishSubsessionReport(child.id, preview.sourceHash, '仅为探索记录');
    const another = await wb.createSession('codex', cwd, offlineProjectId);
    await assert.rejects(wb.attachSubsessionReport(another.id, child.id, report.id), /直接子会话/);
    const otherProjectId = 'project_' + 'b'.repeat(32);
    wb.store.settings.workspaceSnapshot!.profile.projects.push({ ...parent.binding!.project, id: otherProjectId, name: '另一项目' });
    const foreign = await wb.createSession('codex', cwd, otherProjectId);
    await assert.rejects(wb.attachSubsessionReport(foreign.id, child.id, report.id), /直接子会话/);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('Git Subsession worktrees include dirty and untracked files without changing the parent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-subsession-git-'));
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await fs.writeFile(path.join(repo, 'code.py'), 'VALUE = 1\n');
  execFileSync('git', ['-C', repo, 'add', 'code.py']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  await fs.writeFile(path.join(repo, 'code.py'), 'VALUE = 2\n');
  await fs.writeFile(path.join(repo, 'notes.txt'), 'untracked\n');
  const workspace = await forkWorkspace(repo, path.join(root, 'app-data'), randomUUID());
  try {
    assert.equal(workspace.kind, 'git-worktree'); assert.notEqual(workspace.cwd, repo);
    assert.equal(await fs.readFile(path.join(workspace.cwd, 'code.py'), 'utf8'), 'VALUE = 2\n');
    assert.equal(await fs.readFile(path.join(workspace.cwd, 'notes.txt'), 'utf8'), 'untracked\n');
    await fs.writeFile(path.join(workspace.cwd, 'code.py'), 'VALUE = 3\n');
    assert.equal(await fs.readFile(path.join(repo, 'code.py'), 'utf8'), 'VALUE = 2\n');
  } finally { await removeForkWorkspace(workspace, repo); await fs.rm(root, { recursive: true, force: true }); }
});
