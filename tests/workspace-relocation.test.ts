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
// @ts-expect-error Shared JavaScript CLI fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

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

test('explicit pending moves recover after restart', () => fixture(async ({ wb, source, target, save }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  s.status = 'running'; await fs.writeFile(path.join(source, 'artifact.txt'), 'artifact'); await save();
  const restored = new Workbench(wb.store.root, () => {}, () => {});
  try {
    await restored.store.init(); grantTestWorkspace(restored, source);
    const current = restored.store.sessions.find(item => item.id === s.id)!; current.status = 'idle';
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
  await wb.flushProjectDirectories(); assert(s.directoryMove?.error, 'failed migrations wait for an explicit retry');
  await wb.setSessionDirectoryMode(s.id, 'project');
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

test('nested targets are rejected; external directory links are preserved without copying their contents', () => fixture(async ({ wb, root, source, target }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const nested = path.join(source, 'nested'); await fs.mkdir(nested);
  s.directoryMove = { id: randomUUID(), from: source, to: nested };
  await assert.rejects(relocateWorkspace(wb.store.root, s), /互相包含/);
  s.directoryMove = { id: randomUUID(), from: source, to: target };
  const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'private.txt'), 'private');
  await fs.symlink(outside, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await relocateWorkspace(wb.store.root, s);
  assert((await fs.lstat(path.join(target, 'linked'))).isSymbolicLink());
  assert.equal(await fs.realpath(path.join(target, 'linked')), outside);
  assert.deepEqual(await fs.readdir(outside), ['private.txt']);
  assert.equal(await fs.readFile(path.join(outside, 'private.txt'), 'utf8'), 'private');
}));

test('old records retain their original directory and discard implicit pending moves on upgrade', () => fixture(async ({ wb, source, target }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  delete s.directoryMode; s.directoryMove = { id: randomUUID(), from: source, to: target, error: 'legacy unsupported link' };
  wb.store.inputs[s.id] = { text: '未发送的任务', sourceIds: [], answers: {} };
  await wb.store.save();
  const restored = new Workbench(wb.store.root, () => {}, () => {});
  try {
    await restored.store.init(); grantTestWorkspace(restored, source);
    const current = restored.session(s.id);
    assert.equal(current.directoryMode, 'fixed'); assert.equal(current.directoryMove, undefined);
    await restored.saveProjectDirectory(offlineProjectId, target, projectDirectoryKey(restored.store.settings.workspaceSnapshot!.profile, offlineProjectId));
    await restored.reconcileProjectDirectories(); await restored.flushProjectDirectories();
    assert.equal(current.cwd, source); assert.equal(current.directoryMove, undefined);
    assert.equal(restored.store.inputs[s.id].text, '未发送的任务');
    await restored.setSessionDirectoryMode(s.id, 'project'); assert.equal(current.cwd, target);
  } finally { await restored.close(); }
}));

test('old docs pointing at new/docs converges on the existing directory without replacing or copying it', () => fixture(async ({ wb, source, target, save }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const docs = path.join(target, 'docs'); await fs.mkdir(docs); await fs.writeFile(path.join(docs, 'guide.md'), 'existing project documentation');
  const inode = (await fs.stat(docs)).ino;
  await fs.symlink(docs, path.join(source, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  await save();
  assert.equal(s.cwd, target); assert.equal(s.directoryMove, undefined); assert.equal((await fs.stat(docs)).ino, inode);
  assert(!(await fs.lstat(docs)).isSymbolicLink()); assert.equal(s.directoryChange!.conflicts.length, 0);
  assert.equal(await fs.realpath(path.join(source, 'docs')), docs);
  assert.deepEqual(await fs.readdir(docs), ['guide.md']);
}));

test('internal links follow copied conflict directories, including sibling links and subsequent sessions', () => fixture(async ({ wb, source, target, save }) => {
  const one = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const two = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const original = path.join(source, 'z-docs'), existing = path.join(target, 'z-docs');
  await fs.mkdir(original); await fs.mkdir(existing);
  await fs.writeFile(path.join(original, 'note.txt'), 'original'); await fs.writeFile(path.join(existing, 'note.txt'), 'existing');
  await fs.symlink(original, path.join(source, 'a-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.symlink(existing, path.join(target, 'a-link'), process.platform === 'win32' ? 'junction' : 'dir');
  one.outputFiles = [path.join(source, 'a-link', 'note.txt')];
  await save();
  assert.equal(one.cwd, target); assert.equal(two.cwd, target);
  assert.deepEqual(one.directoryChange!.conflicts, two.directoryChange!.conflicts);
  assert.equal(await fs.readFile(one.outputFiles[0], 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(target, 'a-link', 'note.txt'), 'utf8'), 'existing');
  assert((await fs.realpath(path.dirname(one.outputFiles[0]))).startsWith(target));
}));

test('internal directory cycles fail before copying; continuing in the old directory preserves drafts and pauses queued input', () => fixture(async ({ wb, root, source, target, save }) => {
  const cli = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success' }); wb.store.settings.providerPaths.codex = cli.launcher;
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const a = path.join(source, 'a'), b = path.join(source, 'b'); await fs.mkdir(a); await fs.mkdir(b);
  await fs.symlink(b, path.join(a, 'to-b'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.symlink(a, path.join(b, 'to-a'), process.platform === 'win32' ? 'junction' : 'dir');
  wb.store.inputs[s.id] = { text: '保留草稿', sourceIds: [], answers: {} };
  await wb.inputQueue.enqueue(s.id, { text: '排队任务', sourceIds: [], answers: {} });
  await save(); assert.match(s.directoryMove!.error!, /循环/); assert.equal(s.cwd, source);
  assert.deepEqual(await fs.readdir(target), []); assert.equal(s.inputQueue?.paused, true);
  await assert.rejects(wb.send(s.id, '尚未选择'), /继续使用原目录/);
  await wb.setSessionDirectoryMode(s.id, 'fixed'); assert.equal(s.directoryMove, undefined);
  assert.equal(wb.store.inputs[s.id].text, '保留草稿'); assert.equal(s.inputQueue?.items[0].input.text, '排队任务');
  await wb.inputQueue.pump(s.id); assert.equal(s.messages.length, 0, 'choosing a directory never sends a queued message');
  await wb.send(s.id, '继续使用原目录');
  const deadline = Date.now() + 10000;
  while (['starting', 'running'].includes(s.status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(s.cwd, source); assert(s.messages.some(message => message.role === 'user'));
  assert.equal(s.status, 'idle', s.error || 'resumed conversation should finish'); assert(s.messages.some(message => message.role === 'assistant'));
}));

test('a destination link is never used as a writable directory for ordinary source files', () => fixture(async ({ wb, root, source, target, save }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'external');
  await fs.mkdir(path.join(source, 'docs')); await fs.writeFile(path.join(source, 'docs', 'new.txt'), 'local');
  await fs.symlink(outside, path.join(target, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  await save(); assert.equal(s.cwd, target);
  assert.deepEqual(await fs.readdir(outside), ['keep.txt']);
  assert.equal(await fs.readFile(path.join(s.directoryChange!.conflicts[0], 'new.txt'), 'utf8'), 'local');
}));

test('a source link changed after an interrupted copy cannot redirect a resumed migration', () => fixture(async ({ wb, root, source, target }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const first = path.join(root, 'first'), second = path.join(root, 'second'); await fs.mkdir(first); await fs.mkdir(second);
  const link = path.join(source, 'docs'); await fs.symlink(first, link, process.platform === 'win32' ? 'junction' : 'dir');
  s.directoryMove = { id: randomUUID(), from: source, to: target };
  await relocateWorkspace(wb.store.root, s);
  await fs.unlink(link); await fs.symlink(second, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(relocateWorkspace(wb.store.root, s), /链接在迁移期间发生变化/);
  assert.equal(await fs.realpath(path.join(target, 'docs')), first); assert.equal(s.cwd, source);
}));

test('a link to the new workspace root is refused before creating a new recursive directory', () => fixture(async ({ wb, source, target }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  await fs.writeFile(path.join(source, 'a-note.txt'), 'must not partially copy');
  await fs.symlink(target, path.join(source, 'z-loop'), process.platform === 'win32' ? 'junction' : 'dir');
  s.directoryMove = { id: randomUUID(), from: source, to: target };
  await assert.rejects(relocateWorkspace(wb.store.root, s), /自身或上级目录/);
  assert.deepEqual(await fs.readdir(target), []);
}));

test('link creation failure retains the original workspace; explicit retry succeeds without touching the external target', () => fixture(async ({ wb, root, source, target, save }) => {
  const s = await wb.createSession('cursor', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(outside, path.join(source, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  const original = fs.symlink;
  fs.symlink = async (...args: Parameters<typeof fs.symlink>) => { if (args[1] === path.join(target, 'docs')) throw Object.assign(new Error('denied'), { code: 'EPERM' }); return original(...args); };
  try { await save(); } finally { fs.symlink = original; }
  assert.equal(s.cwd, source); assert.match(s.directoryMove!.error!, /无法.*保留文件链接/);
  await wb.setSessionDirectoryMode(s.id, 'project');
  assert.equal(s.cwd, target); assert.equal(await fs.realpath(path.join(target, 'docs')), outside);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
}));

test('metadata already linked to the target project is reused and conversation logs still work after switching', () => fixture(async ({ wb, root, source, target, save }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const metadata = path.join(source, '.workbench'), destination = path.join(target, '.workbench');
  await fs.rename(metadata, destination); await fs.symlink(destination, metadata, process.platform === 'win32' ? 'junction' : 'dir');
  const original = await fs.readFile(s.handoffPath, 'utf8'), inode = (await fs.stat(s.handoffPath)).ino;
  await fs.mkdir(path.join(target, 'docs')); await fs.writeFile(path.join(target, 'docs', 'note.txt'), 'project file');
  await fs.symlink(path.join(target, 'docs'), path.join(source, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  await save(); assert.equal(s.cwd, target, s.directoryMove?.error || 'metadata alias should be reused'); assert.equal(s.directoryMove, undefined);
  assert.equal(await fs.readFile(s.handoffPath, 'utf8'), original); assert.equal((await fs.stat(s.handoffPath)).ino, inode);
  assert((await fs.lstat(metadata)).isSymbolicLink()); assert.equal(await fs.readFile(path.join(source, 'docs', 'note.txt'), 'utf8'), 'project file');
  await wb.saveHandoff(s.id, '切换后保存的摘要'); assert((await wb.projectJournal(s.id)).text.includes(s.id));
  const cli = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success', confirmCwd: true }); wb.store.settings.providerPaths.codex = cli.launcher;
  await wb.send(s.id, '继续项目工作');
  const deadline = Date.now() + 8000;
  while (['starting', 'running', 'approval'].includes(s.status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(s.status, 'idle', s.error || 'conversation should continue after the directory switch'); assert(s.messages.some(message => message.role === 'assistant'));
}));

test('moving from a linked metadata root copies only the selected session and preserves other sessions', () => fixture(async ({ wb, root, source, target, save }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const other = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false); other.directoryMode = 'fixed';
  const physical = path.join(root, 'shared-metadata'), logical = path.join(source, '.workbench');
  await fs.rename(logical, physical); await fs.symlink(physical, logical, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(other.handoffPath, 'other session remains unchanged');
  await fs.writeFile(path.join(physical, 'unrelated.txt'), 'shared root file');
  await save(); assert.equal(s.cwd, target, s.directoryMove?.error || 'session metadata should copy'); assert.equal(other.cwd, source);
  assert.equal(await fs.readFile(s.handoffPath, 'utf8'), await fs.readFile(path.join(physical, 'sessions', s.id, 'handoff.md'), 'utf8'));
  assert.equal(await fs.readFile(other.handoffPath, 'utf8'), 'other session remains unchanged');
  await assert.rejects(fs.stat(path.join(target, '.workbench', 'sessions', other.id)), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(target, '.workbench', 'unrelated.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(physical, 'unrelated.txt'), 'utf8'), 'shared root file');
}));

test('the target metadata root may be an existing junction without replacing other session data', () => fixture(async ({ wb, root, source, target, save }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const physical = path.join(root, 'target-metadata'); await fs.mkdir(physical); await fs.writeFile(path.join(physical, 'keep.txt'), 'keep');
  await fs.symlink(physical, path.join(target, '.workbench'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = await fs.readFile(s.handoffPath, 'utf8');
  await save(); assert.equal(s.cwd, target, s.directoryMove?.error || 'target metadata alias should be supported');
  assert.equal(await fs.readFile(path.join(physical, 'sessions', s.id, 'handoff.md'), 'utf8'), before);
  assert.equal(await fs.readFile(path.join(physical, 'keep.txt'), 'utf8'), 'keep');
  await wb.saveHandoff(s.id, '新摘要'); assert.equal(await fs.readFile(s.handoffPath, 'utf8'), '新摘要');
}));

test('a metadata root retargeted between migration attempts is refused', () => fixture(async ({ wb, root, source, target }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const physical = path.join(root, 'original-metadata'), changed = path.join(root, 'changed-metadata'), logical = path.join(source, '.workbench');
  await fs.rename(logical, physical); await fs.symlink(physical, logical, process.platform === 'win32' ? 'junction' : 'dir');
  s.directoryMove = { id: randomUUID(), from: source, to: target }; await relocateWorkspace(wb.store.root, s);
  const handoff = path.join(target, '.workbench', 'sessions', s.id, 'handoff.md'), original = await fs.readFile(handoff, 'utf8');
  await fs.mkdir(changed); await fs.unlink(logical); await fs.symlink(changed, logical, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(relocateWorkspace(wb.store.root, s), /会话数据目录链接已变化/);
  assert.equal(await fs.readFile(handoff, 'utf8'), original); assert.deepEqual(await fs.readdir(changed), []); assert.equal(s.cwd, source);
}));

test('metadata root support does not allow nested journal links during migration', () => fixture(async ({ wb, root, source, target, save }) => {
  const s = await wb.createSession('codex', source, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const metadata = path.join(root, 'shared-metadata'), logical = path.join(source, '.workbench');
  await fs.rename(logical, metadata); await fs.symlink(metadata, logical, process.platform === 'win32' ? 'junction' : 'dir');
  const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(outside, path.join(metadata, 'sessions', s.id, 'project-journal'), process.platform === 'win32' ? 'junction' : 'dir');
  await save(); assert.equal(s.cwd, source); assert.match(s.directoryMove!.error!, /会话数据内部包含符号链接/);
  assert.deepEqual(await fs.readdir(target), []); assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
}));
