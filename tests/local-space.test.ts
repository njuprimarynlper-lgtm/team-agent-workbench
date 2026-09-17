import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { LocalFileConnection } from '../src/core/local-files';
import { memberConfig } from '../src/admin/member-config';
import { readRegistry, diskPath, writeRegistry, passwordHash } from '../src/core/local-space';
import { Workbench } from '../src/core/workbench';

async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-local-'));
  const root = path.join(base, 'share'); await fs.mkdir(root);
  const admin = new LocalAdminConnection(() => {});
  const profile = { mode: 'local' as const, localRoot: root, root: '/srv/teamspace', host: 'local', port: 22, username: 'admin', fingerprint: '' };
  await admin.connect(profile, 'admin-test-password', '', async () => { throw new Error('SSH must not be used'); });
  await admin.operation({ op: 'initialize' });
  await admin.operation({ op: 'group_create', label: 'workbench' });
  await admin.operation({ op: 'group_create', label: 'other' });
  for (const username of ['alice', 'bob', 'carol']) await admin.operation({ op: 'user_create', username, name: username, password: 'member-test-password', groups: [username === 'carol' ? 'local_other' : 'local_workbench'], contentAdminGroups: username === 'alice' ? ['local_workbench'] : [] });
  const config = (username: string) => memberConfig(admin.snapshot.profile!, admin.snapshot.state!, username, username === 'carol' ? 'local_other' : 'local_workbench');
  const connect = async (username: string) => { const c = new LocalFileConnection(); const p = config(username); await c.connect(p, 'member-test-password', async () => false); await c.loadManifest(); await c.loadManifest(); return c; };
  const clean = async () => { admin.disconnect(); if (!base.startsWith(path.join(os.tmpdir(), 'workbench-local-'))) throw new Error('unsafe cleanup'); await fs.rm(base, { recursive: true, force: true, maxRetries: 4 }); };
  return { base, root, admin, profile, config, connect, clean };
}

test('group member changes preserve other groups and roles even from a stale admin connection', async () => {
  const x = await setup();
  const another = new LocalAdminConnection(() => {});
  try {
    await another.connect(x.profile, 'admin-test-password', '', async () => false);
    await x.admin.operation({ op: 'group_member', username: 'alice', group: 'local_other', role: 'admin' });
    await another.operation({ op: 'group_member', username: 'alice', group: 'local_workbench', role: 'remove', handoffs: { 'local_workbench': null } });
    let user = (await readRegistry(x.root)).state.users.alice;
    assert.deepEqual(user.groups, ['local_other']); assert.deepEqual(user.contentAdminGroups, ['local_other']);
    await x.admin.operation({ op: 'group_member', username: 'alice', group: 'local_workbench', role: 'admin' });
    await x.admin.operation({ op: 'group_member', username: 'alice', group: 'local_workbench', role: 'member', handoffs: { 'local_workbench': null } });
    await x.admin.operation({ op: 'group_member', username: 'alice', group: 'local_workbench', role: 'member', handoffs: { 'local_workbench': null } });
    user = (await readRegistry(x.root)).state.users.alice;
    assert.deepEqual(new Set(user.groups), new Set(['local_workbench', 'local_other']));
    assert.equal(user.groups!.length, 2); assert.deepEqual(user.contentAdminGroups, ['local_other']);
    await assert.rejects(x.admin.operation({ op: 'group_member', username: 'ghost', group: 'local_other', role: 'admin' }), /成员不存在/);
    await assert.rejects(x.admin.operation({ op: 'group_member', username: 'alice', group: 'local_missing', role: 'admin' }), /项目组不存在/);
    await assert.rejects(x.admin.operation({ op: 'group_member', username: 'alice', group: 'local_other', role: 'root' } as any));
  } finally { another.disconnect(); await x.clean(); }
});

test('unassigned users can join later; removing membership revokes live access and preserves files', async () => {
  const x = await setup();
  try {
    await x.admin.operation({ op: 'user_create', username: 'newuser', name: '未分组', password: 'member-test-password', groups: [] });
    assert.deepEqual((await readRegistry(x.root)).state.users.newuser.groups, []);
    const alice = await x.connect('alice'), p = await alice.createProject('保留成果');
    await x.admin.operation({ op: 'group_member', username: 'newuser', group: 'local_workbench', role: 'member' });
    const member = await x.connect('newuser'), binding = member.binding(p.id);
    const source = path.join(x.base, 'history.txt'); await fs.writeFile(source, 'keep-history');
    await member.ensurePersonalFolder(binding, binding.project.historyPath);
    const target = binding.project.historyPath + '/history.txt'; await member.upload(binding, source, target, () => {});
    await x.admin.operation({ op: 'group_member', username: 'newuser', group: 'local_workbench', role: 'remove' });
    await assert.rejects(member.list(binding, p.remoteRoot), /不属于此项目组/);
    assert.equal(await fs.readFile(await diskPath(x.root, target), 'utf8'), 'keep-history');
    assert((await readRegistry(x.root)).state.users.newuser.enabled);
    await x.admin.operation({ op: 'group_member', username: 'newuser', group: 'local_workbench', role: 'member' });
    assert.equal((await member.preview(binding, target)).content, 'keep-history');
    alice.disconnect(); member.disconnect();
  } finally { await x.clean(); }
});
test('local admin: empty-root bootstrap, hashed passwords, registration, group assignment, export and reconnect', async () => {
  const x = await setup();
  try {
    const data = await readRegistry(x.root), raw = JSON.stringify(data);
    assert(!raw.includes('admin-test-password')); assert(!raw.includes('member-test-password'));
    assert.equal(data.state.users.alice.contentAdminGroups![0], 'local_workbench');
    assert.deepEqual(data.state.users.bob.contentAdminGroups, []);
    const exported = x.config('alice'); assert.equal(exported.mode, 'local'); assert.equal(exported.localRoot, await fs.realpath(x.root)); assert(!JSON.stringify(exported).includes('password'));
    assert((await fs.stat(path.join(x.root, 'projects/workbench'))).isDirectory());
    const another = new LocalAdminConnection(() => {});
    await another.connect({ ...x.profile, username: '' }, '', '', async () => false);
    assert.equal(another.snapshot.actor, '本地管理员'); assert.equal(another.snapshot.profile!.username, data.administrator);
    await another.connect({ ...x.profile, username: 'alice' }, 'ignored-password', '', async () => false);
    assert.equal(another.snapshot.profile!.username, data.administrator);
    another.disconnect();
    await assert.rejects(another.operation({ op: 'initialize' }), /先连接/);
    await another.connect(x.profile, 'admin-test-password', '', async () => false);
    await another.operation({ op: 'status' }); assert.equal(Object.keys(another.snapshot.state!.users).length, 3); another.disconnect();
    const nonempty = path.join(x.base, 'nonempty'); await fs.mkdir(nonempty); await fs.writeFile(path.join(nonempty, 'keep.txt'), 'keep');
    await assert.rejects(another.connect({ ...x.profile, localRoot: nonempty }, 'admin-test-password', '', async () => false), /空目录/);
    assert.equal(await fs.readFile(path.join(nonempty, 'keep.txt'), 'utf8'), 'keep');
    await assert.rejects(x.admin.operation({ op: 'user_create', username: 'alice', name: '', password: 'some-password' }), /已存在/);
    await assert.rejects(x.admin.operation({ op: 'user_groups', username: 'bob', groups: [], contentAdminGroups: ['local_workbench'] }), /未加入/);
    const longUser = 'u'.repeat(32), label = 'g'.repeat(14), group = 'local_' + label;
    await x.admin.operation({ op: 'group_create', label });
    await x.admin.operation({ op: 'user_create', username: longUser, name: longUser, password: 'long-user-password', groups: [group] });
    const longProfile = memberConfig(x.admin.snapshot.profile!, x.admin.snapshot.state!, longUser, group);
    assert(longProfile.id.length <= 80); assert.equal(longProfile.username, longUser);
  } finally { await x.clean(); }
});

test('local admin opens legacy shares without credentials, preserves registry and rejects a replaced share', async () => {
  const x = await setup(), another = new LocalAdminConnection(() => {});
  try {
    const data = await readRegistry(x.root); data.administrator = '旧管理员'; data.credentials['旧管理员'] = passwordHash('old-password');
    await writeRegistry(x.root, data);
    const file = await diskPath(x.root, '/.workbench-local/registry.json'), before = await fs.readFile(file, 'utf8');
    const saved = await another.connect({ ...x.profile, username: '' }, '', '', async () => { throw new Error('local mode must not authenticate over SSH'); });
    assert.equal(saved.username, '旧管理员'); assert.equal(another.snapshot.verified, true);
    await another.operation({ op: 'status' }); assert.equal(await fs.readFile(file, 'utf8'), before);
    await another.operation({ op: 'user_groups', username: 'bob', groups: ['local_other'], contentAdminGroups: [] });
    assert.equal((await readRegistry(x.root)).credentials['旧管理员'], data.credentials['旧管理员']);
    const replacement = await readRegistry(x.root); replacement.state.teamId = 'different-space'; await writeRegistry(x.root, replacement);
    await assert.rejects(another.operation({ op: 'group_create', label: 'wrong' }), /共享区已改变/);
    await assert.rejects(another.connect(saved, '', '', async () => false), /身份已改变/);
    assert.equal(another.snapshot.connected, false);
    const current = await readRegistry(x.root); assert.equal(current.state.groups.local_wrong, undefined);
    await another.connect({ ...x.profile, username: '' }, '', '', async () => false);
    await fs.rename(file, file + '.moved');
    await assert.rejects(another.operation({ op: 'status' }), /登记文件不存在/);
    await assert.rejects(another.operation({ op: 'initialize' }), /登记文件不存在/);
    await fs.rename(file + '.moved', file);
    await assert.rejects(another.connect({ ...x.profile, localRoot: path.join(x.base, 'missing'), username: '' }, '', '', async () => false), /不存在/);
  } finally { another.disconnect(); await x.clean(); }
});
test('local shared files: project roles, real disk transfers, team result and uploaded trajectory visibility', async () => {
  const x = await setup();
  try {
    const alice = await x.connect('alice'), project = await alice.createProject('完善团队工作台');
    assert((await fs.stat(path.join(x.root, 'projects/workbench/完善团队工作台/trajectories'))).isDirectory());
    await assert.rejects(alice.createProject(project.name), /EEXIST/);
    const bob = await x.connect('bob'), carol = await x.connect('carol');
    assert.equal(bob.profile!.projects[0].id, project.id); assert.equal(carol.profile!.projects.length, 0);
    await assert.rejects(bob.createProject('拒绝'), /子管理员/);
    const binding = alice.binding(project.id), bb = bob.binding(project.id);
    const file = path.join(x.base, 'result.md'); await fs.writeFile(file, '# 改进工作台\n验证管理员与成员流程');
    await alice.ensurePersonalFolder(binding, project.uploadPath);
    const target = project.uploadPath + '/notes.md'; await alice.upload(binding, file, target, () => {});
    assert.match((await bob.preview(bb, target)).content, /改进工作台/);
    assert.equal((await bob.list(bb, project.uploadPath)).length, 1);
    await assert.rejects(bob.upload(bb, file, target, () => {}), /模拟权限拒绝/);
    await alice.upload(binding, file, target, () => {}); // Identical retry is idempotent.
    await alice.ensurePersonalFolder(binding, project.historyPath); await alice.upload(binding, file, project.historyPath + '/history.md', () => {});
    assert((await bob.preview(bb, project.historyPath + '/history.md')).content);
    assert((await bob.list(bb, project.remoteRoot + '/trajectories')).some(e => e.name === 'alice'));
    await assert.rejects(carol.list(binding, project.remoteRoot), /身份不一致/);
    const download = path.join(x.base, 'download.md'); await bob.download(bb, target, download); assert.equal(await fs.readFile(download, 'utf8'), await fs.readFile(file, 'utf8'));
    await assert.rejects(bob.preview(bb, project.remoteRoot + '/.workbench-project.json'), /管理记录/);
    alice.disconnect(); bob.disconnect(); carol.disconnect();
  } finally { await x.clean(); }
});
test('local permission changes apply to live user connections, including password reset and role revocation', async () => {
  const x = await setup();
  try {
    const alice = await x.connect('alice'), p = await alice.createProject('工作台'), bob = await x.connect('bob'), binding = bob.binding(p.id);
    await x.admin.operation({ op: 'user_enabled', username: 'bob', enabled: false }); await assert.rejects(bob.list(binding, p.remoteRoot), /已停用/);
    await x.admin.operation({ op: 'user_enabled', username: 'bob', enabled: true }); assert((await bob.list(binding, p.remoteRoot)).length);
    await x.admin.operation({ op: 'user_groups', username: 'bob', groups: [], contentAdminGroups: [] }); await assert.rejects(bob.list(binding, p.remoteRoot), /不属于此项目组/);
    await x.admin.operation({ op: 'user_groups', username: 'bob', groups: ['local_workbench'], contentAdminGroups: [] });
    await x.admin.operation({ op: 'user_password', username: 'bob', password: 'replacement-password' }); await assert.rejects(bob.list(binding, p.remoteRoot), /凭据已改变/);
    await assert.rejects(bob.connect(x.config('bob'), 'member-test-password', async () => false), /密码错误/);
    await bob.connect(x.config('bob'), 'replacement-password', async () => false); await bob.verifyWorkspace('/projects/workbench');
    await x.admin.operation({ op: 'user_groups', username: 'alice', groups: ['local_workbench'], contentAdminGroups: [], handoffs: { local_workbench: null } }); await assert.rejects(alice.createProject('revoked'), /子管理员/);
    await alice.loadManifest(); assert.equal(alice.workspace!.canCreateProject, false);
    alice.disconnect(); bob.disconnect();
  } finally { await x.clean(); }
});
test('local paths reject traversal, Windows aliases, case bypass, links, forged bindings and changed project identity', async () => {
  const x = await setup();
  try {
    const alice = await x.connect('alice'), p = await alice.createProject('安全检查'), b = alice.binding(p.id);
    await assert.rejects(alice.preview(b, p.remoteRoot + '/../escape'), /不能包含/);
    for (const suffix of ['nul.txt', 'file:stream', 'file.', 'file ']) await assert.rejects(diskPath(x.root, p.remoteRoot + '/' + suffix, true), /非法文件名/);
    const physical = path.join(x.root, 'projects/workbench/安全检查'), outside = path.join(x.base, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(outside, path.join(physical, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(alice.preview(b, p.remoteRoot + '/link/secret.txt'), /符号链接/);
    if (process.platform === 'win32') await assert.rejects(alice.list(b, p.remoteRoot + '/TRAJECTORIES'), /大小写/);
    await assert.rejects(alice.list({ ...b, project: { ...b.project, remoteRoot: '/projects/other' } }, '/projects/other'), /入口配置/);
    await fs.writeFile(path.join(physical, '.workbench-project.json'), JSON.stringify({ version: 1, id: 'project_' + 'a'.repeat(32), name: p.name }));
    await assert.rejects(alice.list(b, p.remoteRoot), /项目身份/);
    alice.disconnect();
  } finally { await x.clean(); }
});
test('local Workbench: multiple independent sessions, frozen handoffs, real queued uploads and restart', async () => {
  const x = await setup(); const appRoot = path.join(x.base, 'user-data');
  const wb = new Workbench(appRoot, () => {}, () => {});
  try {
    await wb.store.init(); await wb.configureWorkspace(x.config('alice'), 'member-test-password', x.base, async () => false);
    const p = await wb.createProject('完善本项目'), a = await wb.createSession('codex', x.base, p.id), b = await wb.createSession('codex', x.base, p.id);
    assert.notEqual(a.handoffPath, b.handoffPath); await wb.saveHandoff(a.id, '# 完善本项目\n管理员操作说明补充'); assert(!String(await fs.readFile(b.handoffPath)).includes('说明补充'));
    a.messages.push({ id: 'test-message', role: 'assistant', text: '测试桩完成记录，未调用模型', createdAt: new Date().toISOString() });
    const transfer = await wb.archive(a.id);
    const deadline = Date.now() + 10000; while (transfer.status === 'queued' || transfer.status === 'running') { if (Date.now() > deadline) throw new Error('upload timeout'); await new Promise(r => setTimeout(r, 20)); }
    assert.equal(transfer.status, 'done', transfer.error || ''); assert((await fs.stat(await diskPath(x.root, transfer.target))).size > 100);
    await wb.saveInput(b.id, { text: '补充用户使用说明', sourceIds: [], answers: {} }); await wb.close();
    const restored = new Workbench(appRoot, () => {}, () => {}); await restored.store.init(); await restored.restoreLocalWorkspace();
    assert(restored.workspaceReady); assert.equal(restored.store.inputs[b.id].text, '补充用户使用说明'); assert.equal(restored.remote.connected, false); await restored.close();
  } finally { await wb.close(); await x.clean(); }
});
