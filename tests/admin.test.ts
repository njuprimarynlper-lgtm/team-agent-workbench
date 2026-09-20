import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Server, utils } from 'ssh2';
import { AdminConnection } from '../src/admin/connection';
import { adminOperationSchema, adminProfileSchema, adminConnectSchema } from '../src/admin/types';
import { systemUsername } from '../src/core/account-login';
import { inflateSync } from 'node:zlib';
const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;

test('admin schemas reject privilege and content operations; secrets are not profile fields', () => {
  assert.equal(adminOperationSchema.safeParse({ op: 'write', path: '/etc/passwd' }).success, false);
  assert.equal(adminOperationSchema.safeParse({ op: 'user_create', username: '-R /', password: 'abcdefgh', name: 'bad' }).success, false);
  const profile = adminProfileSchema.parse({ host: 'host', port: 22, username: 'admin', password: 'secret', sudoPassword: 'secret', root: '/srv/teamspace' });
  assert.equal('password' in profile, false); assert.equal('sudoPassword' in profile, false);
});

test('only the local admin connection accepts omitted account and password', () => {
  const profile = { mode: 'local' as const, localRoot: 'D:/share', host: 'local', port: 22 };
  const local = adminConnectSchema.parse({ profile }); assert.equal(local.password, ''); assert.equal(local.profile.username, '');
  for (const mode of [undefined, 'sftp']) {
    assert.equal(adminConnectSchema.safeParse({ profile: { ...profile, mode } }).success, false);
    assert.equal(adminConnectSchema.safeParse({ profile: { ...profile, mode, username: 'root' } }).success, false);
    assert.equal(adminConnectSchema.safeParse({ profile: { ...profile, mode, username: 'root' }, password: '1' }).success, true);
  }
});

async function fixture(role: 'root' | 'sudo' | 'project', writableManifest = false, alias = 'worker', login?: string) {
  const requests: any[] = [], commands: string[] = [], clients: any[] = [];
  const state: any = { initialized: true, users: {}, groups: {}, sftpConfigured: true, storageVersion: 1 };
  const control = { failNext: false, holdStorage: false, authenticationAttempts: 0 };
  const server = new Server({ hostKeys: [key] }, client => {
    clients.push(client); client.on('error', () => {});
    client.on('authentication', context => { if (context.method === 'password') control.authenticationAttempts++; context.method === 'password' && context.password === 'login-secret' && (!login || context.username === login) ? context.accept() : context.reject(); });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('sftp', (accept, reject) => {
        if (role !== 'project') { reject(); return; }
        const sftp = accept(), content = Buffer.from(JSON.stringify({ version: 1, root: '/srv/teamspace', users: { [alias]: { contentGroups: [{ id: 'wb_test_ocr', name: 'OCR' }] } } }));
        sftp.on('LSTAT', (id, target) => sftp.attrs(id, { mode: target.endsWith('.json') ? (writableManifest ? 0o100666 : 0o100644) : 0o40755, uid: 0, gid: 0, size: content.length, atime: 0, mtime: 0 }));
        sftp.on('OPEN', id => sftp.handle(id, Buffer.from('roles')));
        sftp.on('FSTAT', id => sftp.attrs(id, { mode: 0o100644, uid: 0, gid: 0, size: content.length, atime: 0, mtime: 0 }));
        sftp.on('READ', (id, _handle, offset, length) => offset >= content.length ? sftp.status(id, utils.sftp.STATUS_CODE.EOF) : sftp.data(id, content.subarray(offset, offset + length)));
        sftp.on('CLOSE', id => sftp.status(id, utils.sftp.STATUS_CODE.OK));
      });
      session.on('exec', (accept, _reject, info) => {
        commands.push(info.command); const channel = accept();
        if (info.command === 'id -u') { channel.write(role === 'root' ? '0\n' : '1001\n'); channel.exit(0); channel.end(); return; }
        if (role === 'project') { channel.stderr.write('not in sudoers'); channel.exit(1); channel.end(); return; }
        const encoded = info.command.match(/b64decode\("([A-Za-z0-9+/=]+)"/); assert(encoded);
        assert(info.command.length < 30000);
        assert.match(inflateSync(Buffer.from(encoded[1], 'base64')).toString(), /def main\(request\)/);
        let buffer = '', authorized = role === 'root';
        channel.on('data', (data: Buffer) => {
          buffer += data.toString(); let n: number;
          while ((n = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
            if (!authorized) { assert.equal(line, 'sudo-secret'); authorized = true; channel.write('WORKBENCH_READY\n'); continue; }
            const input = JSON.parse(line); requests.push(input);
            if (input.op === 'storage_usage' && control.holdStorage) continue;
            if (control.failNext && !['probe', 'status'].includes(input.op)) {
              control.failNext = false;
              state.operations = { 'group_create:ocr': { id: 'group_create:ocr', op: 'group_create', request: { op: 'group_create', label: 'ocr' }, status: 'failed', completed: ['成员用户组已创建'], error: 'injected failure' } };
              channel.write(JSON.stringify({ ok: false, error: 'injected failure' }) + '\n'); channel.exit(1); channel.end(); continue;
            }
            const result = input.op === 'probe' ? { administrator: true, actor: role, missingCommands: [] } : input.op === 'status' ? state : input.op === 'storage_usage' ? { scannedAt: '2026-09-20T00:00:00.000Z', path: input.path, name: '共享空间', total: { bytes: 10, files: 1, directories: 1, directBytes: 0 }, volume: { totalBytes: 100, freeBytes: 60 }, categories: [], groups: [], users: [], children: [], childCount: 0, offset: input.offset, limit: input.limit, warningCount: 0, warnings: [] } : { state };
            channel.write(JSON.stringify({ ok: true, value: result }) + '\n'); channel.exit(0); channel.end();
          }
        });
        if (authorized) channel.write('WORKBENCH_READY\n'); else { channel.stderr.write('WORKBENCH_'); setTimeout(() => channel.stderr.write('SUDO'), 5); }
      });
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { requests, commands, control, port: address.port, close: async () => { clients.forEach(c => c.end()); await new Promise<void>(r => server.close(() => r())); } };
}
test('admin rejects a changed server identity before sending login credentials', async () => {
  const f = await fixture('root'), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  try {
    await assert.rejects(remote.connect({ host: '127.0.0.1', port: f.port, username: 'admin', fingerprint: 'SHA256:wrong-server', root: '/srv/teamspace' }, 'login-secret', '', async () => { throw new Error('不应询问'); }), /服务器身份发生变化.*登录密码尚未发送/);
    assert.equal(f.control.authenticationAttempts, 0);
  } finally { remote.disconnect(); await f.close(); }
});
for (const role of ['root', 'sudo'] as const) test(role + ': SSH verifies privilege and sends passwords only over stdin', async () => {
  const f = await fixture(role), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  try {
    await remote.connect({ host: '127.0.0.1', port: f.port, username: 'admin', fingerprint: '', root: '/srv/teamspace' }, 'login-secret', 'sudo-secret', async () => true);
    assert.equal(remote.snapshot.role, 'administrator');
    await remote.operation({ op: 'user_create', username: 'alice', name: '测试成员', password: 'new-secret' });
    assert.equal(f.requests.at(-1).password, 'new-secret');
    assert(!JSON.stringify(remote.snapshot).includes('secret')); assert(!f.commands.some(c => c.includes('secret')));
  } finally { remote.disconnect(); await f.close(); }
});
test('remote storage usage is a scoped read-only administrator operation', async () => {
  const f = await fixture('root'), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  try {
    await remote.connect({ host: '127.0.0.1', port: f.port, username: 'admin', fingerprint: '', root: '/srv/teamspace' }, 'login-secret', '', async () => true);
    const report = await remote.storageUsage({ path: 'projects/OCR', offset: 20, limit: 50 });
    assert.equal(report.total.bytes, 10);
    assert.deepEqual(f.requests.at(-1), { op: 'storage_usage', path: 'projects/OCR', offset: 20, limit: 50, root: '/srv/teamspace' });
    assert.equal(remote.snapshot.busy, false);
    f.control.holdStorage = true;
    const controller = new AbortController(), pending = remote.storageUsage({ path: '', offset: 0, limit: 100 }, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, /取消空间统计/);
  } finally { remote.disconnect(); await f.close(); }
});
test('project subadmin authenticates through protected server assignment and cannot manage users', async () => {
  const f = await fixture('project'), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  try {
    await remote.connect({ host: '127.0.0.1', port: f.port, username: 'worker', fingerprint: '', root: '/srv/teamspace' }, 'login-secret', '', async () => true);
    assert.equal(remote.snapshot.role, 'project_admin'); assert.deepEqual(remote.snapshot.contentGroups, [{ id: 'wb_test_ocr', name: 'OCR' }]);
    await assert.rejects(remote.operation({ op: 'user_create', username: 'bad', name: 'bad', password: 'new-secret' }), /只有总管理员/);
    await assert.rejects(remote.storageUsage({ path: '', offset: 0, limit: 100 }), /只有总管理员/);
    assert.equal(f.commands.length, 0);
  } finally { remote.disconnect(); await f.close(); }
});
test('writable role manifest cannot grant a project admin entry', async () => {
  const f = await fixture('project', true), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  try {
    await assert.rejects(remote.connect({ host: '127.0.0.1', port: f.port, username: 'worker', fingerprint: '', root: '/srv/teamspace' }, 'login-secret', '', async () => true));
    assert.equal(remote.snapshot.verified, false);
  } finally { remote.disconnect(); await f.close(); }
});

test('#7 remote operation failure automatically refreshes partial state for recovery', async () => {
  const f = await fixture('root'), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  try {
    await remote.connect({ host: '127.0.0.1', port: f.port, username: 'admin', fingerprint: '', root: '/srv/teamspace' }, 'login-secret', '', async () => true);
    f.control.failNext = true;
    await assert.rejects(remote.operation({ op: 'group_create', label: 'ocr' }), /injected failure/);
    assert.equal(remote.snapshot.busy, false); assert.equal(f.requests.at(-1).op, 'status');
    assert.deepEqual(remote.snapshot.state!.operations!['group_create:ocr'].completed, ['成员用户组已创建']);
  } finally { remote.disconnect(); await f.close(); }
});


test('admin app preserves literal server accounts and accepts mapped project members', async () => {
  for (const [role, alias, login] of [['root', 'OpsAdmin', 'OpsAdmin'], ['project', '张三', systemUsername('张三')]] as const) {
    const f = await fixture(role, false, alias, login), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
    try {
      await remote.connect({ host: '127.0.0.1', port: f.port, username: alias, fingerprint: '', root: '/srv/teamspace' }, 'login-secret', '', async () => true);
      assert.equal(remote.snapshot.role, role === 'root' ? 'administrator' : 'project_admin');
      assert.equal(remote.snapshot.profile!.username, alias);
    } finally { remote.disconnect(); await f.close(); }
  }
});
