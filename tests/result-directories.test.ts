import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { changeResultDirectory, resultDirectoryLabel, resultDirectoryNodes, resultItemFolder, resultDirectoryRoots } from '../src/shared/result-directories';
import { ContentFiles } from '../src/core/content-files';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { persistPersonalMove } from '../src/core/personal-move';
import { AccountSync, mergeAccountRecords } from '../src/core/account-sync';
import { accountIdentity } from '../src/shared/account-data';
import { scopeAccountSnapshot } from '../src/shared/account-scope';
import type { RemoteBinding, ProjectConclusion, Draft } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

test('five roots, independent subtrees, and deletion redirects existing references without losing children', () => {
  assert.deepEqual(resultDirectoryRoots.map(item => item.name), ['项目目标', '项目资料', '已有能力', '探索记录', '待办事项']);
  assert.equal(resultItemFolder({ title: 'legacy file', kind: 'file' }, []), 'project_material');
  const parent = randomUUID(), child = randomUUID();
  let dirs = changeResultDirectory([], { action: 'create', id: parent, parentId: 'capability', name: '离线评测' });
  dirs = changeResultDirectory(dirs, { action: 'create', id: child, parentId: parent, name: '词典增强' });
  assert.equal(resultDirectoryLabel(child, dirs), '已有能力 / 离线评测 / 词典增强');
  assert.throws(() => changeResultDirectory(dirs, { action: 'rename', id: parent, revision: 99, name: 'stale' }), /已更新/);
  dirs = changeResultDirectory(dirs, { action: 'delete', id: parent, revision: 1 });
  assert.equal(resultItemFolder({ title: '', folderId: parent }, dirs), 'capability');
  assert.equal(resultDirectoryLabel(child, dirs), '已有能力 / 词典增强');
  assert.equal(resultDirectoryNodes(dirs).filter(item => !item.root).length, 1);
  assert.equal(resultItemFolder({ title: '', category: 'todo', folderId: child }, []), 'todo', 'foreign library IDs do not import a hierarchy');
  assert.throws(() => changeResultDirectory(dirs, { action: 'create', id: randomUUID(), parentId: parent, name: 'late' }), /删除/);
  assert.throws(() => changeResultDirectory(dirs, { action: 'create', id: randomUUID(), parentId: 'capability', name: '词典增强' }), /已有/);
});

test('delete rejects promoted sibling name collisions without mutating its input', () => {
  const a = randomUUID(), b = randomUUID(), c = randomUUID();
  let dirs = changeResultDirectory([], { action: 'create', id: a, parentId: 'todo', name: 'A' });
  dirs = changeResultDirectory(dirs, { action: 'create', id: b, parentId: 'todo', name: 'B' });
  dirs = changeResultDirectory(dirs, { action: 'create', id: c, parentId: a, name: 'b' });
  assert.throws(() => changeResultDirectory(dirs, { action: 'delete', id: a, revision: 1 }), /重名/);
  assert.equal(dirs[0].deletedAt, undefined);
});

test('team directory permissions, publication destinations, stale atomic moves and path redirects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-result-dirs-')); let actor = { username: 'alice', admin: false };
  const files = new ContentFiles(root, async () => actor), binding = { username: 'alice', project: { id: 'p', name: 'Fixture', remoteRoot: '/p', uploadPath: '/p/submissions/alice', historyPath: '/p/trajectories/alice' } } as RemoteBinding;
  try {
    const id = randomUUID(); await files.directories(binding, { action: 'create', id, parentId: 'exploration', name: '团队验证' });
    await assert.rejects(files.directories(binding, { action: 'delete', id, revision: 1 }), /管理员/);
    const file = path.join(root, 'source.md'); await fs.writeFile(file, 'evidence');
    const meta = { kind: 'contribution' as const, title: '测试成果', description: 'evidence', folderId: id };
    const a = await files.publish(binding, file, '/p/submissions/alice/a.md', meta);
    const b = await files.publish(binding, file, '/p/submissions/alice/b.md', meta);
    const refs = [a, b].map(value => ({ id: value.id, version: 1, folderVersion: 0 }));
    await assert.rejects(files.moveResults(binding, { folderId: 'todo', items: refs }), /管理员/);
    actor.admin = true;
    await assert.rejects(files.moveResults(binding, { folderId: 'todo', items: [refs[0], { ...refs[1], version: 4 }] }), /已更新/);
    assert.ok((await files.list(binding)).every(value => value.folderId === id));
    const moved = await files.moveResults(binding, { folderId: 'todo', items: refs });
    assert.ok(moved.every(value => value.revision === 1 && value.folderVersion === 1 && value.folderId === 'todo'));
    await assert.rejects(files.moveResults(binding, { folderId: id, items: refs }), /已更新/);
    actor.admin = false;
    const revised = await files.publish(binding, file, '/p/submissions/alice/a2.md', { ...meta, folderId: undefined, publicationTarget: { id: a.id, revision: 1 } });
    assert.equal(revised.folderId, 'todo'); assert.equal(revised.folderVersion, 1); assert.equal(revised.revision, 2);
    await assert.rejects(files.publish(binding, file, '/p/submissions/alice/invalid.md', { ...meta, folderId: randomUUID() }), /不存在/);
    actor.admin = true; await files.directories(binding, { action: 'delete', id, revision: 1 });
    await assert.rejects(files.publish(binding, file, '/p/submissions/alice/deleted.md', meta), /删除/);
    const restored = new ContentFiles(root, async () => actor); assert.ok((await restored.directories(binding))[0].deletedAt);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('offline personal folders persist, keep content versions, validate batch moves and sync by account', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-personal-dirs-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const folder = randomUUID(); await wb.changePersonalResultDirectory(offlineProjectId, { action: 'create', id: folder, parentId: 'capability', name: '个人评测' });
    const a = await wb.createConclusion(offlineProjectId, '成果 A', 'body', 'capability', undefined, undefined, [], folder);
    const b = await wb.createConclusion(offlineProjectId, '成果 B', 'body', 'todo');
    await assert.rejects(wb.movePersonalResults(offlineProjectId, { folderId: folder, items: [{ id: b.id, version: 1, folderVersion: 0 }, { id: a.id, version: 2, folderVersion: 0 }] }), /已更新/);
    assert.equal(b.folderId, undefined);
    await wb.movePersonalResults(offlineProjectId, { folderId: folder, items: [{ id: b.id, version: 1, folderVersion: 0 }] });
    assert.equal(b.version, 1); assert.equal(b.folderVersion, 1);
    const profile = wb.store.settings.workspaceSnapshot!.profile, owner = accountIdentity(profile);
    const snapshot = wb.snapshot();
    snapshot.settings.resultDirectories = [...wb.personalResultDirectories(offlineProjectId), { ...wb.personalResultDirectories(offlineProjectId)[0], id: randomUUID(), accountOwner: 'foreign-owner' }];
    assert.equal(scopeAccountSnapshot(snapshot).settings.resultDirectories?.length, 1);
    assert.equal(scopeAccountSnapshot({ ...snapshot, accountChanging: true }).settings.resultDirectories?.length, 0);
    const sync = new AccountSync(wb.store, wb.remote, () => {});
    const records = (sync as any).collect(profile);
    assert.equal(records['directory:' + folder].accountOwner, owner);
    const remoteFolder = { ...records['directory:' + folder], id: randomUUID(), name: '另一台电脑' };
    const merged = mergeAccountRecords(records, { ...records, ['directory:' + folder]: { ...records['directory:' + folder], revision: 2, name: '本机修改' } }, { ...records, ['directory:' + remoteFolder.id]: remoteFolder });
    assert.equal(merged.conflicts.length, 0);
    (sync as any).apply(merged.records, profile);
    assert.equal(wb.personalResultDirectories(offlineProjectId).length, 2);
    const conflict = mergeAccountRecords(records, { ...records, ['directory:' + folder]: { ...records['directory:' + folder], name: '左边' } }, { ...records, ['directory:' + folder]: { ...records['directory:' + folder], name: '右边' } });
    assert.equal(conflict.conflicts.length, 1);
    await wb.store.save(); const restored = new Store(wb.store.root); await restored.init();
    assert.equal(restored.settings.resultDirectories?.length, 2); assert.equal(restored.conclusions.find(item => item.id === b.id)?.folderId, folder);
    assert.throws(() => wb.personalResultDirectories('foreign-project'), /无法访问/);
    await sync.close();
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('migration journals referenced directory paths and reuses existing target paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-move-dirs-'));
  try {
    const source = new Store(path.join(root, 'source')), target = new Store(path.join(root, 'target')); await source.init(); await target.init();
    const original = randomUUID(), targetParent = randomUUID();
    source.settings.resultDirectories = [{ id: original, name: '离线评测', parentId: 'capability', revision: 1, projectId: 'p1', accountOwner: 'a' }];
    target.settings.resultDirectories = [{ id: targetParent, name: '离线评测', parentId: 'capability', revision: 1, projectId: 'p2', accountOwner: 'b' }];
    const item: ProjectConclusion = { id: randomUUID(), projectId: 'p2', accountOwner: 'b', title: '迁移成果', content: 'body', sources: [], version: 1, updatedAt: new Date().toISOString(), folderId: original };
    await persistPersonalMove(source, target, { version: 1, targetRoot: target.root, sessions: [], drafts: [], conclusions: [item], inputs: {} });
    assert.equal(target.conclusions[0].folderId, targetParent); assert.equal(target.settings.resultDirectories.length, 1);
    assert.equal(source.settings.resultDirectories[0].id, original);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('organization saves each conclusion to its chosen folder and team imports keep independent personal paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-draft-dirs-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const folder = randomUUID(); await wb.changePersonalResultDirectory(offlineProjectId, { action: 'create', id: folder, parentId: 'exploration', name: '私有验证' });
    const session = await wb.createSession('codex', root, offlineProjectId), id = randomUUID();
    const draft: Draft = { id, sessionId: session.id, binding: session.binding, title: '整理', body: 'body', files: [], inputDir: root, outputPath: path.join(root, 'draft.md'), createdAt: new Date().toISOString(), generation: 'ready', artifacts: [
      { id: id + '-1', title: '第一项', category: 'exploration', body: '第一份证据', selected: true, fields: {}, target: '/explorations' },
      { id: id + '-2', title: '第二项', category: 'capability', body: '第二份证据', selected: true, fields: {}, target: '/capabilities' },
    ] }; wb.store.drafts.push(draft);
    const ids = draft.artifacts!.map(item => item.id);
    await assert.rejects(wb.saveDraftPersonal(id, ids, { [ids[1]]: randomUUID() }), /不存在/);
    assert.equal(wb.conclusions(offlineProjectId).length, 0);
    const saved = await wb.saveDraftPersonal(id, ids, { [ids[0]]: folder, [ids[1]]: 'project_goal' });
    assert.deepEqual(saved.map(item => item.folderId), [folder, 'project_goal']);
    await wb.saveDraftPersonal(id, ids, {}); assert.equal(wb.conclusions(offlineProjectId).length, 2);
    const shared = { id: randomUUID(), title: '团队发现', description: '团队原文', category: 'exploration', kind: 'contribution', folderId: randomUUID(), revision: 1, path: '/p/result.md', author: 'alice', updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
    wb.remote.contentList = async () => [shared] as any;
    const imported = await wb.importContentConclusion(offlineProjectId, shared.id, 1, folder);
    assert.equal(imported.conclusion.folderId, folder); assert.notEqual(shared.folderId, folder);
    await wb.saveConclusion(imported.conclusion.id, imported.conclusion.title, '我的独立编辑');
    shared.revision = 2; shared.description = '团队新版';
    const next = await wb.importContentConclusion(offlineProjectId, shared.id, 2, 'project_material');
    assert.equal(next.conclusion.folderId, 'project_material'); assert.equal(imported.conclusion.content, '我的独立编辑');
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});
