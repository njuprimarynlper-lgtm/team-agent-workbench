import ssh2 from 'ssh2';
import { generateKeyPairSync, createHash } from 'node:crypto';
const { Server, utils } = ssh2;
// SSH transport + deterministic operation responses; Python tests cover actual step recovery.
export async function adminServer() {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
  const fingerprint = 'SHA256:' + createHash('sha256').update(utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const state = { initialized: true, teamId: 'test', loginGroup: 'wb_test_members', sftpConfigured: true, users: {}, groups: { wb_test_ocr: { name: 'wb_test_ocr', label: 'ocr', adminGroup: 'wb_test_ocr_admin', workspace: '/projects/ocr' } }, operations: {} };
  const requests = [], clients = [], control = { failGroup: true };
  const server = new Server({ hostKeys: [key] }, client => {
    clients.push(client); client.on('error', () => {});
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'root' && ctx.password === 'test-password' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); session.on('sftp', (_accept, reject) => reject());
      session.on('exec', (accept, _reject, info) => {
        const channel = accept();
        if (info.command === 'id -u') { channel.write('0\n'); channel.exit(0); channel.end(); return; }
        let buffer = '';
        const finish = (ok, value, error) => { channel.write(JSON.stringify({ ok, value, error }) + '\n'); channel.exit(ok ? 0 : 1); channel.end(); };
        channel.on('data', data => {
          buffer += data.toString(); const index = buffer.indexOf('\n'); if (index < 0) return;
          const request = JSON.parse(buffer.slice(0, index)); buffer = ''; requests.push(request);
          if (request.op === 'probe') { finish(true, { administrator: true, actor: 'root', missingCommands: [] }); return; }
          if (request.op === 'status') { finish(true, state); return; }
          if (request.op === 'group_create' && control.failGroup) {
            control.failGroup = false;
            state.operations['group_create:' + request.label] = { id: 'group_create:' + request.label, op: 'group_create', request: { op: 'group_create', label: request.label }, status: 'failed', completed: ['成员用户组已创建'], error: '测试：子管理员组创建失败' };
            finish(false, null, '测试：子管理员组创建失败'); return;
          }
          if (request.op === 'recover') {
            const job = state.operations[request.operationId]; job.status = 'done'; job.completed.push('子管理员用户组已创建', '工作目录与 ACL 已配置');
            const label = job.request.label, name = 'wb_test_' + label;
            state.groups[name] = { name, label, adminGroup: name + '_admin', workspace: '/projects/' + label };
          }
          if (request.op === 'user_create') state.users[request.username] = { username: request.username, name: request.name, enabled: true, uid: 1001, groups: request.groups || [], contentAdminGroups: request.contentAdminGroups || [] };
          finish(true, { state });
        });
        channel.write('WORKBENCH_READY\n');
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, requests, profile: { host: '127.0.0.1', port: server.address().port, username: 'root', fingerprint, root: '/srv/teamspace' }, close: async () => { clients.forEach(c => c.end()); await new Promise(resolve => server.close(resolve)); } };
}
