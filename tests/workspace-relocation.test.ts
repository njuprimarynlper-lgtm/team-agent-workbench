import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { relocateWorkspace } from '../src/core/workspace-relocation';
import { projectDirectoryKey } from '../src/shared/project-directory';
import { sessionContext } from '../src/core/session-context';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import { PERSONAL_PROJECT_ID } from '../src/shared/personal-workspace';

async function fixture(run: (f: { wb: Workbench; root: string; source: string; target: string; save(): Promise<string> }) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-relocation-')));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  await fs.mkdir(source); await fs.mkdir(target);
  const wb = new Workbench(path.join(root, 'store'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, source);
    const key = projectDirectoryKey(wb.store.settings.workspaceSnapshot!.profile, offlineProjectId);
    await run({ wb, root, source, target, save: () => wb.saveProjectDirectory(offlineProjectId, target, key) });
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
}

test('running shared-directory sessions defer copying; fixed and imported sessions retain their roots', () => fixture(async ({ wb, source, target, save }) => {
  const parent = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const child = await wb.createSession('codex', source, offlineProjectId, 'work', parent.id, undefined, 'inherit', false);
  child.fork = { parentId: parent.id, capturedAt: parent.createdAt, parentMessageCount: 0, snapshotHash: '', sourceId: '', inheritedSourceIds: [], workspaceKind: 'shared-directory', workspaceRoot: source };
  const imported = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  imported.nativeLive = true; delete imported.directoryMode;
  const fixed = await wb.createSession('cursor', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false); fixed.directoryMode = 'fixed';
  parent.status = 'running';
  await save();
  assert(parent.directoryMove); assert(child.directoryMove); assert.equal(imported.directoryMove, undefined); assert.equal(fixed.directoryMove, undefined);
  assert.equal(parent.cwd, source); assert.equal(child.cwd, source);
  await fs.writeFile(path.join(source, 'last-output.txt'), 'written at turn completion');
  parent.status = 'idle'; await wb.flushProjectDirectories();
  assert.equal(parent.cwd, target); assert.equal(child.cwd, target); assert.equal(child.fork.workspaceRoot, target);
  assert.equal(imported.cwd, source); assert.equal(fixed.cwd, source);
  assert.equal(await fs.readFile(path.join(target, 'last-output.txt'), 'utf8'), 'written at turn completion');
  assert.equal(await fs.readFile(child.handoffPath, 'utf8'), await fs.readFile(path.join(source, '.workbench', 'sessions', child.id, 'handoff.md'), 'utf8'));
  await wb.setSessionDirectoryMode(parent.id, 'fixed'); assert.equal(child.directoryMode, 'fixed');
  await wb.setSessionDirectoryMode(child.id, 'project'); assert.equal(parent.directoryMode, 'project');
}));

test('unassigned sessions keep separate roots when project folders are reconciled', () => fixture(async ({ root, source, target }) => {
  const local = new Workbench(path.join(root, 'personal'), () => {}, () => {}, undefined, () => ({}), undefined, undefined, undefined, true);
  try {
    await local.store.init(); await local.restoreLocalWorkspace();
    const one = await local.createSession('codex', source, PERSONAL_PROJECT_ID, 'work', undefined, undefined, 'inherit', false);
    const two = await local.createSession('codex', target, PERSONAL_PROJECT_ID, 'work', undefined, undefined, 'inherit', false);
    const managed = await local.createSession('codex', '', PERSONAL_PROJECT_ID, 'work', undefined, undefined, 'inherit', false);
    await local.reconcileProjectDirectories(); await local.flushProjectDirectories();
    assert.equal(one.cwd, source); assert.equal(two.cwd, target); assert.notEqual(managed.cwd, source); assert.notEqual(managed.cwd, target);
    assert(!local.store.sessions.some(s => s.directoryMove));
  } finally { await local.close(); }
}));

test('queued next turns wait for migration and dispatch in the new directory', () => fixture(async ({ wb, source, target, save }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  s.status = 'running'; await save();
  await wb.inputQueue.enqueue(s.id, { text: 'next task', sourceIds: [], answers: {} });
  const used: string[] = []; wb.send = async id => { used.push(wb.session(id).cwd); return true; };
  s.status = 'idle'; await wb.inputQueue.pump(s.id); assert.deepEqual(used, []);
  await wb.flushProjectDirectories(); await wb.inputQueue.pump(s.id);
  assert.deepEqual(used, [target]); assert.equal(s.inputQueue!.items.length, 0);
}));

test('conflicting directories stay whole, reuse one retained copy across sessions and keep references valid', () => fixture(async ({ wb, source, target, save }) => {
  const one = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const two = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  await fs.mkdir(path.join(source, 'repo', '.git'), { recursive: true }); await fs.mkdir(path.join(target, 'repo', '.git'), { recursive: true });
  await fs.writeFile(path.join(source, 'repo', 'code.txt'), 'original'); await fs.writeFile(path.join(target, 'repo', 'code.txt'), 'other repository');
  await fs.writeFile(path.join(source, 'repo', '.git', 'HEAD'), 'source'); await fs.writeFile(path.join(target, 'repo', '.git', 'HEAD'), 'destination');
  one.nativeId = randomUUID(); const nativeId = one.nativeId;
  one.messages.push({ id: 'old', role: 'assistant', text: 'Old path: ' + source, createdAt: one.createdAt });
  one.outputFiles = [path.join(source, 'repo', 'code.txt')];
  await save();
  assert.equal(one.cwd, target); assert.equal(one.nativeId, nativeId); assert.equal(one.messages[0].text, 'Old path: ' + source);
  assert.deepEqual(one.directoryChange!.conflicts, two.directoryChange!.conflicts);
  assert.equal(one.directoryChange!.conflicts.length, 1);
  assert.equal(await fs.readFile(path.join(target, 'repo', 'code.txt'), 'utf8'), 'other repository');
  assert.equal(await fs.readFile(one.outputFiles[0], 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(one.directoryChange!.conflicts[0], '.git', 'HEAD'), 'utf8'), 'source');
  const context = sessionContext(one, '继续', []); assert.match(context.text, /工作目录变更/); assert(context.text.includes(target));
  one.messages.push({ id: 'next', role: 'user', text: context.text, userText: '继续', createdAt: one.createdAt, context: { ...context.context, accepted: true, nativeId } });
  assert.doesNotMatch(sessionContext(one, '再继续', []).text, /工作目录变更/);
}));

test('root Git repositories also remain coherent when the destination already contains different files', () => fixture(async ({ wb, source, target, save }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  await fs.mkdir(path.join(source, '.git')); await fs.mkdir(path.join(target, '.git'));
  await fs.writeFile(path.join(source, '.git', 'HEAD'), 'source'); await fs.writeFile(path.join(target, '.git', 'HEAD'), 'other');
  await fs.writeFile(path.join(source, 'code.txt'), 'source code');
  await save(); const retained = s.directoryChange!.conflicts[0];
  assert.equal(await fs.readFile(path.join(retained, 'code.txt'), 'utf8'), 'source code');
  assert.equal(await fs.readFile(path.join(retained, '.git', 'HEAD'), 'utf8'), 'source');
  await assert.rejects(fs.access(path.join(target, 'code.txt')));
}));

test('persisted pending moves recover after restart, including legacy managed sessions', () => fixture(async ({ wb, root, source, target, save }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  delete s.directoryMode; s.status = 'running'; await fs.writeFile(path.join(source, 'artifact.txt'), 'artifact'); await save();
  const restored = new Workbench(wb.store.root, () => {}, () => {});
  try {
    await restored.store.init(); grantTestWorkspace(restored, source);
    const current = restored.store.sessions.find(item => item.id === s.id)!; current.status = 'idle';
    delete current.directoryMove; // Simulate upgrading a legacy record with only the project setting.
    await restored.reconcileProjectDirectories(); assert(current.directoryMove);
    await restored.flushProjectDirectories(); assert.equal(current.cwd, target);
    assert.equal(await fs.readFile(path.join(target, 'artifact.txt'), 'utf8'), 'artifact');
  } finally { await restored.close(); }
  s.status = 'idle';
}));

test('failed persistence keeps the original cwd; verified copies can be retried without overwriting', () => fixture(async ({ wb, source, target, save }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  await fs.writeFile(path.join(source, 'output.txt'), 'keep me');
  const originalSave = wb.store.save.bind(wb.store); let fail = true;
  wb.store.save = async () => { if (s.cwd === target && fail) { fail = false; throw new Error('disk unavailable'); } await originalSave(); };
  await save(); assert.equal(s.cwd, source); assert.match(s.directoryMove!.error!, /disk unavailable/);
  assert.equal(await fs.readFile(path.join(source, 'output.txt'), 'utf8'), 'keep me');
  s.directoryMove!.retryAt = 0; await wb.flushProjectDirectories();
  assert.equal(s.cwd, target); assert.equal(s.directoryMove, undefined);
  assert.equal(await fs.readFile(path.join(target, 'output.txt'), 'utf8'), 'keep me');
}));

test('invalid targets block the next send, while choosing fixed cancels pending migration', () => fixture(async ({ wb, source, target, save }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  s.status = 'running'; await save(); s.status = 'idle'; await fs.rmdir(target);
  await wb.flushProjectDirectories(); assert(s.directoryMove?.error);
  await assert.rejects(wb.send(s.id, 'continue'), /工作目录尚未切换完成/);
  assert.equal(s.messages.length, 0); assert.equal(s.cwd, source);
  await wb.setSessionDirectoryMode(s.id, 'fixed'); assert.equal(s.directoryMove, undefined);
  await fs.mkdir(target); await wb.setSessionDirectoryMode(s.id, 'project'); assert.equal(s.cwd, target);
}));

test('moving project ownership adopts the target directory without changing conversation identity', () => fixture(async ({ wb, source, target }) => {
  const profile = wb.store.settings.workspaceSnapshot!.profile, targetId = 'project_' + 'b'.repeat(32);
  profile.projects.push({ ...profile.projects[0], id: targetId, name: '目标项目' });
  await wb.saveProjectDirectory(targetId, target, projectDirectoryKey(profile, targetId));
  const s = await wb.createSession('cursor', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  s.nativeId = 'same-cursor-session'; await fs.writeFile(path.join(source, 'download.zip'), 'download');
  await wb.moveWithinLocal(targetId, { sessionId: s.id }); const current = wb.session(s.id);
  assert.equal(current.cwd, target); assert.equal(current.nativeId, s.nativeId); assert.equal(current.binding!.project.id, targetId);
  assert.equal(await fs.readFile(path.join(target, 'download.zip'), 'utf8'), 'download');
}));

test('nested targets and symbolic links cannot escape or recursively copy a workspace', () => fixture(async ({ wb, root, source, target }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const nested = path.join(source, 'nested'); await fs.mkdir(nested);
  s.directoryMove = { id: randomUUID(), from: source, to: nested };
  await assert.rejects(relocateWorkspace(wb.store.root, s), /互相包含/);
  s.directoryMove = { id: randomUUID(), from: source, to: target };
  const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'private.txt'), 'private');
  await fs.symlink(outside, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(relocateWorkspace(wb.store.root, s), /符号链接/);
  assert.deepEqual(await fs.readdir(target), []);
}));
