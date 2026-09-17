import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import { generateKeyPairSync, createHash } from 'node:crypto';
import path from 'node:path';

// A protocol fixture, not a Linux emulator. Explicit denials exercise how clients
// handle ACL failures without changing any real machine accounts or directories.
export async function teamServer(accounts = { alice: 'alice', bob: 'bob', carol: 'carol' }, password = 'test-password') {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
  const publicKey = utils.parseKey(key).getPublicSSH(), fingerprint = 'SHA256:' + createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '');
  const nodes = new Map(), clients = [], codes = utils.sftp.STATUS_CODE;
  const state = { admins: [Object.keys(accounts)[0]], failFolder: '', writableRoles: false, memberships: Object.fromEntries(Object.keys(accounts).map(name => [name, ['ocr']])), groupAdmins: {}, legacyRoles: false };
  const directory = (name, mode = 0o40755, uid = 0) => nodes.set(name, { mode, uid, gid: 100, data: Buffer.alloc(0) });
  for (const name of ['/', '/projects', '/projects/ocr', '/projects/denied', '/.workbench']) directory(name);
  nodes.set('/.workbench/roles.json', { mode: 0o100644, uid: 0, gid: 0, data: Buffer.alloc(0) });
  const normalize = value => path.posix.normalize(value);
  const updateRoles = () => {
    const node = nodes.get('/.workbench/roles.json'); node.mode = state.writableRoles ? 0o100666 : 0o100644;
    node.data = Buffer.from(JSON.stringify({ version: 1, ...(!state.legacyRoles ? { membershipVersion: 1 } : {}), root: '/srv/teamspace', users: Object.fromEntries(Object.keys(accounts).map(username => {
      const groups = (state.memberships[username] || []).map(label => ({ id: 'wb_test_' + label, name: label === 'ocr' ? 'OCR' : label.toUpperCase(), workspace: '/projects/' + label }));
      return [username, { groups, contentGroups: groups.filter(g => (g.id === 'wb_test_ocr' ? state.admins : state.groupAdmins[g.id.slice(8)] || []).includes(username)) }];
    })) }));
  };
  const server = new Server({ hostKeys: [key] }, client => {
    let username = '', uid = 0; clients.push(client); client.on('error', () => {});
    client.on('authentication', ctx => { const alias = Object.keys(accounts).find(name => accounts[name] === ctx.username); if (ctx.method === 'password' && ctx.password === password && alias) { username = alias; uid = 1001 + Object.keys(accounts).indexOf(alias); ctx.accept(); } else ctx.reject(); });
    client.on('ready', () => client.on('session', accept => accept().on('sftp', accept => {
      const sftp = accept(), handles = new Map(); let seq = 0;
      const attrs = node => ({ mode: node.mode, uid: node.uid, gid: node.gid, size: node.data.length, atime: 1, mtime: 1 });
      const error = (id, code) => sftp.status(id, code);
      const bits = node => uid === node.uid ? (node.mode >> 6) & 7 : node.gid === (username === 'carol' ? 200 : 100) ? (node.mode >> 3) & 7 : node.mode & 7;
      const canRead = target => {
        const group = target.match(/^\/projects\/([^/]+)/)?.[1]; if (group && !(state.memberships[username] || []).includes(group)) return false;
        if (target === '/projects/denied' || target.startsWith('/projects/denied/')) return false;
        for (let p = target; p !== '/'; p = path.posix.dirname(p)) { const n = nodes.get(p); if (n && !(bits(n) & (n.mode & 0o040000 ? 1 : 4))) return false; }
        return true;
      };
      const canWrite = parent => canRead(parent) && (/^\/projects\/[^/]+$/.test(parent) ? (parent === '/projects/ocr' ? state.admins : state.groupAdmins[parent.split('/')[2]] || []).includes(username) : !!(bits(nodes.get(parent)) & 2));
      const get = (id, raw, callback) => { updateRoles(); const target = normalize(raw), node = nodes.get(target); if (!canRead(target)) error(id, codes.PERMISSION_DENIED); else if (!node) error(id, codes.NO_SUCH_FILE); else callback(node, target); };
      sftp.on('REALPATH', (id, target) => get(id, target, (node, canonical) => sftp.name(id, [{ filename: canonical, longname: '', attrs: attrs(node) }])));
      for (const method of ['STAT', 'LSTAT']) sftp.on(method, (id, target) => get(id, target, node => sftp.attrs(id, attrs(node))));
      sftp.on('OPENDIR', (id, target) => get(id, target, (node, canonical) => { if (!(node.mode & 0o040000)) { error(id, codes.FAILURE); return; } const key = String(++seq); handles.set(key, { target: canonical, directory: true, read: false }); sftp.handle(id, Buffer.from(key)); }));
      sftp.on('READDIR', (id, handle) => {
        const h = handles.get(handle.toString()); if (h.read) { error(id, codes.EOF); return; } h.read = true;
        const entries = [...nodes].filter(([p]) => p !== h.target && path.posix.dirname(p) === h.target).map(([p,n]) => ({ filename: path.posix.basename(p), longname: '', attrs: attrs(n) }));
        entries.length ? sftp.name(id, entries) : error(id, codes.EOF);
      });
      sftp.on('MKDIR', (id, raw, input) => {
        const target = normalize(raw), parent = path.posix.dirname(target);
        if (nodes.has(target)) { error(id, codes.FAILURE); return; }
        if (!nodes.has(parent)) { error(id, codes.NO_SUCH_FILE); return; }
        if (!canWrite(parent) || path.posix.basename(target) === state.failFolder) { error(id, codes.PERMISSION_DENIED); return; }
        directory(target, 0o040000 | (input.mode ?? 0o755), uid); sftp.status(id, codes.OK);
      });
      sftp.on('RMDIR', (id, raw) => {
        const target = normalize(raw); if ([...nodes.keys()].some(p => p.startsWith(target + '/'))) { error(id, codes.FAILURE); return; }
        nodes.delete(target); sftp.status(id, codes.OK);
      });
      sftp.on('OPEN', (id, raw, flags, input) => {
        updateRoles(); const target = normalize(raw), writing = flags & utils.sftp.OPEN_MODE.WRITE;
        if (!canRead(target) || (writing && (!canWrite(path.posix.dirname(target)) || (nodes.has(target) && !(bits(nodes.get(target)) & 2))))) { error(id, codes.PERMISSION_DENIED); return; }
        if (writing) {
          if ((flags & utils.sftp.OPEN_MODE.EXCL) && nodes.has(target)) { error(id, codes.FAILURE); return; }
          nodes.set(target, { mode: 0o100000 | (input.mode ?? 0o644), uid, gid: 100, data: Buffer.alloc(0) });
        }
        if (!nodes.has(target)) { error(id, codes.NO_SUCH_FILE); return; }
        const key = String(++seq); handles.set(key, { target }); sftp.handle(id, Buffer.from(key));
      });
      sftp.on('FSTAT', (id, handle) => sftp.attrs(id, attrs(nodes.get(handles.get(handle.toString()).target))));
      sftp.on('SETSTAT', (id, raw, input) => get(id, raw, node => { if (node.uid !== uid) { error(id, codes.PERMISSION_DENIED); return; } if (input.mode !== undefined) node.mode = (node.mode & 0o170000) | (input.mode & 0o7777); sftp.status(id, codes.OK); }));
      sftp.on('FSETSTAT', (id, handle, input) => { const node = nodes.get(handles.get(handle.toString()).target); if (input.mode !== undefined) node.mode = (node.mode & 0o170000) | (input.mode & 0o7777); sftp.status(id, codes.OK); });
      sftp.on('WRITE', (id, handle, offset, data) => { const node = nodes.get(handles.get(handle.toString()).target), next = Buffer.alloc(Math.max(node.data.length, offset + data.length)); node.data.copy(next); data.copy(next, offset); node.data = next; sftp.status(id, codes.OK); });
      sftp.on('READ', (id, handle, offset, length) => { const node = nodes.get(handles.get(handle.toString()).target); offset >= node.data.length ? error(id, codes.EOF) : sftp.data(id, node.data.subarray(offset, offset + length)); });
      sftp.on('CLOSE', (id, handle) => { handles.delete(handle.toString()); sftp.status(id, codes.OK); });
      sftp.on('REMOVE', (id, target) => { nodes.delete(normalize(target)); sftp.status(id, codes.OK); });
      sftp.on('RENAME', (id, from, to) => { if (nodes.has(to)) { error(id, codes.FAILURE); return; } nodes.set(to, nodes.get(from)); nodes.delete(from); sftp.status(id, codes.OK); });
    })));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { nodes, state, profile: username => ({ id: 'fixture-' + username, host: '127.0.0.1', port: server.address().port, username, fingerprint, name: '测试团队', manifestPath: '', projects: [], workPath: '/projects/ocr' }), close: async () => { clients.forEach(c => c.end()); await new Promise(resolve => server.close(resolve)); } };
}
