import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registryLock } from '../src/core/local-space';
import { Workbench } from '../src/core/workbench';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from './fixtures/member-profile';
import { syncedProject } from './fixtures/synced-project';
import { AccountSync } from '../src/core/account-sync';
import { Store } from '../src/core/store';
import { accountIdentity } from '../src/shared/account-data';
import type { SharedFiles } from '../src/core/shared-files';
import type { ConnectionProfile } from '../src/shared/types';

test('two projects reuse one authenticated filesystem connection and disconnect independently without losing local sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-connections-'));
  const admin = new LocalAdminConnection(() => {}), workbench = new Workbench(path.join(root, 'user'), () => {}, () => {});
  try {
    await fs.mkdir(path.join(root, 'share'));
    await admin.connect({ mode: 'local', localRoot: path.join(root, 'share'), host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
    await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: 'research' });
    await admin.operation({ op: 'user_create', username: 'alice', name: 'Alice', password: '123', groups: ['local_research'], contentAdminGroups: ['local_research'] });
    const profile = memberProfile(admin.snapshot.profile!, admin.snapshot.state!, 'alice');
    await workbench.store.init(); await workbench.configureWorkspace(profile, '123', root, async () => false);
    const a = await syncedProject(workbench, '算法研究', 'local_research'), b = await syncedProject(workbench, '软件开发', 'local_research');
    const session = await workbench.createSession('codex', root, a.id);
    session.messages.push({ id: 'local', role: 'user', text: '未联网也要保留的对话', createdAt: session.createdAt });
    await workbench.store.save();
    // Authentication and project activation are separate, including after restart/relogin.
    await workbench.configureWorkspace(profile, '123', root, async () => false);
    assert.equal(workbench.remote.profile!.projects.length, 2);
    assert.equal(workbench.projectConnected(a.id), false); assert.equal(workbench.projectConnected(b.id), false);
    await assert.rejects(workbench.remote.contentList(workbench.remote.binding(a.id)), /此项目尚未连接/);
    const transport = (workbench.remote as any).backend;
    const reads: string[] = [], read = workbench.remote.contentList.bind(workbench.remote);
    workbench.remote.contentList = binding => { reads.push(binding.project.id); return read(binding); };
    await workbench.connectProject(a.id); await workbench.syncContentUpdates();
    assert(workbench.projectConnected(a.id)); assert(!workbench.projectConnected(b.id)); assert(!reads.includes(b.id));
    await workbench.connectProject(b.id); assert.equal((workbench.remote as any).backend, transport);
    await workbench.disconnectProject(a.id);
    assert(workbench.remote.connected); assert(workbench.projectConnected(b.id));
    await assert.rejects(workbench.remote.projectBrief(workbench.remote.binding(a.id)), /此项目尚未连接/);
    await workbench.remote.contentList(workbench.remote.binding(b.id));
    assert.equal(workbench.session(session.id).messages[0].text, '未联网也要保留的对话');
    await workbench.refreshGroups(); assert(!workbench.projectConnected(a.id));
    await workbench.connectProject(a.id); assert.equal((workbench.remote as any).backend, transport);
    await assert.rejects(workbench.connectProject('foreign-project'), /没有该项目/);
    await workbench.disconnectProject(a.id); await workbench.disconnectProject(b.id);
    assert(workbench.remote.connected); assert(Object.values(workbench.snapshot().projectConnections!).every(state => !state.connected));
  } finally { await workbench.close(); admin.disconnect(); assert(path.basename(root).startsWith('project-connections-')); await fs.rm(root, { recursive: true, force: true }); }
});

test('project-scoped account sync preserves inactive central and local records, attachments, aliases and offline edits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-account-scope-')), store = new Store(root); await store.init();
  const project = (id: string) => ({ id, name: id, remoteRoot: '/projects/' + id, uploadPath: '/projects/' + id, historyPath: '/projects/' + id + '/trajectories' });
  const profile: ConnectionProfile = { id: 'fixture', host: 'local', port: 22, username: 'alice', fingerprint: 'test', name: 'test', manifestPath: '', projects: [project('a'), project('b')] };
  const material = (id: string) => ({ id, projectId: id, title: id, content: 'base', version: 1, updatedAt: '2026-10-23', sources: [], accountOwner: accountIdentity(profile) });
  let snapshot = { revision: 1, records: { 'material:a': material('a'), 'material:b': material('b'), 'alias:b:result': '远端别名' } as Record<string, any> }, reads = 0, files = 0;
  const active = new Set<string>();
  const remote = { connected: true, profile, async accountData(write?: typeof snapshot) { reads++; if (write) snapshot = { revision: snapshot.revision + 1, records: structuredClone(write.records) }; return structuredClone(snapshot); }, async accountFile() { files++; throw new Error('inactive attachment must not transfer'); } } as unknown as SharedFiles;
  const sync = new AccountSync(store, remote, () => {}, undefined, undefined, id => active.has(id));
  try {
    await sync.activate(profile); assert.equal(reads, 0);
    active.add('a'); active.add('b'); sync.connectionChanged(); await sync.sync();
    assert.equal(store.conclusions.length, 2);
    snapshot.records['material:moving'] = { ...material('moving'), projectId: 'a' };
    await sync.sync();
    active.delete('b'); sync.connectionChanged();
    store.conclusions.find(item => item.id === 'moving')!.projectId = 'b';
    store.conclusions.find(item => item.id === 'a')!.content = 'A 修改';
    store.conclusions.find(item => item.id === 'b')!.content = 'B 离线修改';
    store.conclusions.find(item => item.id === 'b')!.sources.push({ id: 'b-source', kind: 'manual', title: '本机依据', content: '保留', path: 'C:\\offline\\b.md', updatedAt: '2026-10-23' });
    const offlineB = structuredClone(store.conclusions.find(item => item.id === 'b'));
    store.settings.contentAliases!['b:result'] = '本机离线别名';
    snapshot.records['material:b'].title = '远端新标题';
    snapshot.records['material:b'].localFiles = [{ id: 'bfile', name: 'b.txt', sha256: 'a'.repeat(64), size: 4 }];
    const before = structuredClone(snapshot.records['material:b']);
    await sync.sync();
    assert.equal(snapshot.records['material:a'].content, 'A 修改');
    assert.equal(snapshot.records['material:moving'].projectId, 'a');
    assert.equal(store.conclusions.find(item => item.id === 'moving')!.projectId, 'b');
    assert.deepEqual(snapshot.records['material:b'], before); assert.equal(files, 0);
    assert.deepEqual(store.conclusions.find(item => item.id === 'b'), offlineB);
    assert.equal(store.conclusions.find(item => item.id === 'b')!.title, 'b');
    assert.equal(store.conclusions.find(item => item.id === 'b')!.content, 'B 离线修改');
    assert.equal(snapshot.records['alias:b:result'], '远端别名'); assert.equal(store.settings.contentAliases!['b:result'], '本机离线别名');
    delete snapshot.records['material:b'].localFiles;
    active.add('b'); sync.connectionChanged(); await sync.sync();
    assert.equal(snapshot.records['material:b'].title, '远端新标题'); assert.equal(snapshot.records['material:b'].content, 'B 离线修改');
    assert.equal(snapshot.records['alias:b:result'], '本机离线别名');
    assert.equal(snapshot.records['material:moving'].projectId, 'b');
    active.clear(); sync.connectionChanged(); const count = reads; await sync.sync(); assert.equal(reads, count);
  } finally { active.clear(); await sync.close(); assert(path.basename(root).startsWith('project-account-scope-')); await fs.rm(root, { recursive: true, force: true }); }
});

test('disconnect during account read does not write or restore a stale project snapshot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-disconnect-race-')), store = new Store(root); await store.init();
  const profile: ConnectionProfile = { id: 'fixture', host: 'local', port: 22, username: 'alice', fingerprint: 'test', name: 'test', manifestPath: '', projects: [{ id: 'a', name: 'a', remoteRoot: '/a', uploadPath: '/a', historyPath: '/a/history' }] };
  let enabled = false, finish!: () => void, writes = 0;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const remote = { connected: true, profile, async accountData(write?: unknown) { if (write) writes++; await wait; return { revision: 1, records: { 'material:a': { id: 'a', projectId: 'a', title: '远端', content: '正文', sources: [] } } }; } } as unknown as SharedFiles;
  const sync = new AccountSync(store, remote, () => {}, undefined, undefined, () => enabled);
  try {
    await sync.activate(profile); enabled = true; sync.connectionChanged(); const job = sync.sync();
    enabled = false; sync.connectionChanged(); finish(); await job;
    assert.equal(writes, 0); assert.equal(store.conclusions.length, 0); assert.equal(sync.state.status, 'offline');
  } finally { finish(); enabled = false; await sync.close(); assert(path.basename(root).startsWith('project-disconnect-race-')); await fs.rm(root, { recursive: true, force: true }); }
});


test('Windows stub retries a lock-file deletion race without removing another writer lock', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-lock-race-')), open = fs.open;
  let attempts = 0, actions = 0;
  (fs as any).open = async (...args: any[]) => {
    if (String(args[0]) === path.join(root, '.workbench-local.lock') && attempts++ === 0) throw Object.assign(new Error('pending deletion'), { code: 'EPERM' });
    return (open as any)(...args);
  };
  try {
    await registryLock(root, async () => { actions++; });
    assert.equal(actions, 1); assert.equal(attempts, 2);
    await assert.rejects(fs.stat(path.join(root, '.workbench-local.lock')), { code: 'ENOENT' });
  } finally { fs.open = open; assert(path.basename(root).startsWith('project-lock-race-')); await fs.rm(root, { recursive: true, force: true }); }
});
