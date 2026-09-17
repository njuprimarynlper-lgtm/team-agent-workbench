import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { accountNameSchema, accountPasswordSchema } from '../src/shared/accounts';
import { errorMessage } from '../src/shared/errors';
import { systemUsername } from '../src/core/account-login';
import { memberConfig } from '../src/admin/member-config';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { LocalFileConnection } from '../src/core/local-files';
import { readRegistry, diskPath } from '../src/core/local-space';
import { SftpConnection } from '../src/core/sftp';
// @ts-expect-error protocol fixture
import { teamServer } from './fixtures/team-server.mjs';

test('account rules allow names, employee IDs, mixed case and short passwords with readable errors', () => {
  for (const name of ['张三', '10086', 'ZhangSan', '欧阳·明', 'A'.repeat(64), 'constructor']) assert.equal(accountNameSchema.parse(name), name);
  assert.equal(accountNameSchema.parse(' 张三 '), '张三');
  for (const name of ['', '../name', 'a/b', 'a\\b', '-root', '__proto__', 'con', 'LPT1', 'a\nb', 'A'.repeat(65)]) {
    const result = accountNameSchema.safeParse(name); assert.equal(result.success, false, name);
    if (!result.success) { const message = errorMessage(result.error); assert.match(message, /[\u4e00-\u9fff]/); assert(!message.includes('invalid_format')); }
  }
  for (const password of ['1', 'abc', '中文']) assert.equal(accountPasswordSchema.parse(password), password);
  for (const password of ['', 'a:b', 'a\nb', 'a\x00b']) assert.equal(accountPasswordSchema.safeParse(password).success, false);
});

test('Windows and Linux derive identical system logins and preserve legacy accounts', () => {
  const names = ['张三', '10086', 'ZhangSan', 'alice', 'worker_2', 'A'.repeat(64), '欧阳·明'];
  const code = 'import json,sys; from server.admin import system_username; print(json.dumps([system_username(n) for n in json.loads(sys.argv[1])]))';
  const linux = JSON.parse(execFileSync('python', ['-c', code, JSON.stringify(names)], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } }));
  assert.deepEqual(names.map(systemUsername), linux);
  assert.equal(systemUsername('alice'), 'alice');
  for (const login of linux) assert.match(login, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.equal(new Set(linux).size, names.length);
});

test('Local administrator and extended-name members: create, export, login, upload, reset, revoke and reconnect on disk', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-accounts-'));
  const root = path.join(base, 'share'); await fs.mkdir(root);
  const admin = new LocalAdminConnection(() => {}), alice = new LocalFileConnection(), bob = new LocalFileConnection();
  const profile = { mode: 'local' as const, localRoot: root, host: 'local', port: 22, username: '管理员', fingerprint: '', root: '/srv/teamspace' };
  try {
    await admin.connect(profile, '1', '', async () => false); await admin.operation({ op: 'initialize' });
    await admin.operation({ op: 'group_create', label: 'demo' });
    for (const username of ['张三', '10086', 'ZhangSan', 'constructor']) await admin.operation({ op: 'user_create', username, name: username, password: '1', groups: ['local_demo'], contentAdminGroups: username === '张三' ? ['local_demo'] : [] });
    const config = (name: string) => memberConfig(admin.snapshot.profile!, admin.snapshot.state!, name, 'local_demo');
    for (const name of ['张三', '10086', 'ZhangSan', 'constructor']) { const c = new LocalFileConnection(); const p = config(name); await c.connect(p, '1', async () => false); await c.loadManifest(); c.disconnect(); }
    await alice.connect(config('张三'), '1', async () => false); await alice.verifyWorkspace('/projects/demo');
    const project = await alice.createProject('身份验证');
    await bob.connect(config('10086'), '1', async () => false); await bob.verifyWorkspace('/projects/demo'); await bob.discoverProjects();
    await assert.rejects(bob.createProject('不该创建'), /子管理员/);
    const source = path.join(base, '成果.md'); await fs.writeFile(source, '工号账号的成果');
    const binding = bob.binding(project.id); await bob.ensurePersonalFolder(binding, binding.project.uploadPath);
    const target = binding.project.uploadPath + '/成果.md'; await bob.upload(binding, source, target, () => {});
    assert.equal((await alice.preview(alice.binding(project.id), target)).content, '工号账号的成果');
    await bob.ensurePersonalFolder(binding, binding.project.historyPath); await bob.upload(binding, source, binding.project.historyPath + '/轨迹.md', () => {});
    await assert.rejects(alice.preview(alice.binding(project.id), binding.project.historyPath + '/轨迹.md'), /模拟权限拒绝/);
    await admin.operation({ op: 'user_password', username: '10086', password: '2' });
    await assert.rejects(bob.list(binding, project.remoteRoot), /凭据已改变/);
    await assert.rejects(bob.connect(config('10086'), '1', async () => false), /密码错误/);
    await bob.connect(config('10086'), '2', async () => false); await bob.verifyWorkspace('/projects/demo'); await bob.discoverProjects();
    await admin.operation({ op: 'user_enabled', username: '10086', enabled: false });
    await assert.rejects(bob.list(bob.binding(project.id), project.remoteRoot), /已停用/);
    await admin.operation({ op: 'user_enabled', username: '10086', enabled: true });
    await admin.operation({ op: 'group_member', username: '10086', group: 'local_demo', role: 'remove' });
    await assert.rejects(bob.list(bob.binding(project.id), project.remoteRoot), /不属于/);
    await assert.rejects(admin.operation({ op: 'user_create', username: 'zhangsan', name: '', password: '1' }), /已存在/);
    assert.equal(await fs.readFile(await diskPath(root, target), 'utf8'), '工号账号的成果');
    admin.disconnect(); await admin.connect(profile, '1', '', async () => false);
    assert.equal((await readRegistry(root)).state.users['张三'].username, '张三');
  } finally {
    admin.disconnect(); alice.disconnect(); bob.disconnect();
    assert(base.startsWith(path.join(os.tmpdir(), 'workbench-accounts-'))); await fs.rm(base, { recursive: true, force: true });
  }
});

test('SFTP authenticates mapped names while protected roles, exported config and personal paths use the account', async () => {
  const aliases = Object.fromEntries(['张三', '10086', 'ZhangSan'].map(name => [name, systemUsername(name)]));
  const server = await teamServer(aliases, '1'); server.state.admins = ['张三'];
  const clients: SftpConnection[] = [];
  try {
    for (const username of ['张三', '10086', 'ZhangSan']) {
      const c = new SftpConnection(); clients.push(c);
      const profile = memberConfig({ ...server.profile(username), username: 'root', root: '/srv/teamspace' },
        { initialized: true, teamId: 'test', sftpConfigured: true, users: { [username]: { username, name: username, enabled: true, groups: ['wb_test_ocr'] } }, groups: { wb_test_ocr: { name: 'wb_test_ocr', label: 'ocr', adminGroup: 'wb_test_ocr_admin', workspace: '/projects/ocr' } } }, username, 'wb_test_ocr');
      await c.connect(profile, '1', async () => false);
      assert.equal(c.profile!.username, username);
      const workspace = await c.verifyWorkspace('/projects/ocr'); assert.equal(workspace.canCreateProject, username === '张三');
      if (username === '张三') await c.createProject('账号兼容'); else await c.discoverProjects();
      const project = c.profile!.projects[0]; assert.equal(path.posix.basename(project.historyPath), username);
      await c.ensurePersonalFolder(c.binding(project.id), project.historyPath);
    }
  } finally { clients.forEach(c => c.disconnect()); await server.close(); }
});
