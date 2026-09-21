import { Client, type ClientChannel } from 'ssh2';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { AdminOperation, AdminProfile, AdminSnapshot, StorageScanRequest, StorageUsageReport } from './types';
import { storageScanSchema } from './types';
import { systemUsername } from '../core/account-login';

// Only a fixed, packaged program is executed. Request data (including passwords)
// travels over encrypted stdin and never becomes command arguments.
export class AdminConnection {
  private client?: Client; private sudoPassword = ''; private code = ''; private rawReady = false;
  snapshot: AdminSnapshot = { connected: false, verified: false, busy: false };
  constructor(private scriptPath: string, private changed: () => void) {}
  disconnect() { this.client?.end(); this.client = undefined; this.sudoPassword = ''; this.rawReady = false; this.snapshot = { profile: this.snapshot.profile, connected: false, verified: false, busy: false }; this.changed(); }
  async connect(profile: AdminProfile, password: string, sudoPassword: string, trust: (key: string) => Promise<boolean>, login = profile.username): Promise<AdminProfile> {
    this.disconnect();
    const acl = await fs.readFile(path.join(path.dirname(this.scriptPath), 'acl_support.py'));
    const worker = deflateSync(Buffer.concat([acl, Buffer.from('\n'), await fs.readFile(path.join(path.dirname(this.scriptPath), 'content.py'))])).toString('base64');
    this.code = deflateSync(Buffer.concat([acl, Buffer.from("\n"), Buffer.from("CONTENT_WORKER_ZLIB_BASE64 = '" + worker + "'\n"), await fs.readFile(this.scriptPath)])).toString('base64');
    const client = new Client(); this.client = client; this.sudoPassword = sudoPassword || password;
    try {
      let fingerprint = '', identityChanged = false, firstConnectionCancelled = false;
      await new Promise<void>((resolve, reject) => {
        client.on('error', reject); client.on('ready', resolve);
        client.on('close', () => { if (this.client === client) this.disconnect(); });
        client.connect({ host: profile.host, port: profile.port, username: login, password, readyTimeout: 30000, keepaliveInterval: 15000,
          hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
            fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
            if (profile.fingerprint) {
              identityChanged = profile.fingerprint !== fingerprint;
              callback(!identityChanged);
            } else void trust(fingerprint).then(accepted => { firstConnectionCancelled = !accepted; callback(accepted); }, () => { firstConnectionCancelled = true; callback(false); });
          },
        });
      }).catch(error => {
        if (identityChanged) throw new Error('服务器身份发生变化，已停止连接。请确认服务器是否重装或迁移，然后重新确认服务器身份；登录密码尚未发送。');
        if (firstConnectionCancelled) throw new Error('已取消首次连接，服务器身份没有保存，登录密码尚未发送。');
        throw error;
      });
      this.snapshot.profile = { ...profile, fingerprint }; this.rawReady = true;
      const contentGroups = await this.readContentRoles(profile);
      if (contentGroups.length) {
        this.snapshot = { ...this.snapshot, connected: true, verified: true, role: 'project_admin', actor: profile.username, contentGroups };
        this.sudoPassword = ''; this.changed(); return this.snapshot.profile!;
      }
      // id -u is fixed and runs under the authenticated SSH account.
      const uid = await this.simple('id -u');
      const probe = await this.execute({ op: 'probe' }, uid.trim() !== '0');
      if (!probe.administrator) throw new Error('服务器未验证管理员权限');
      this.snapshot = { ...this.snapshot, connected: true, verified: true, role: 'administrator', actor: probe.actor, missingCommands: probe.missingCommands, setupIssues: probe.setupIssues, setupNotes: probe.setupNotes, aclBackend: probe.aclBackend, serviceManager: probe.serviceManager };
      this.useSudo = uid.trim() !== '0';
      this.snapshot.state = await this.execute({ op: 'status' }, this.useSudo);
      this.changed(); return this.snapshot.profile!;
    } catch (e: any) {
      this.disconnect();
      // Existing root/sudo logins are literal. Only retry a managed alias after
      // authentication fails; a permissions/host-key failure never triggers retry.
      const mapped = systemUsername(profile.username);
      if (e.level === 'client-authentication' && login === profile.username && mapped !== login) return this.connect(profile, password, sudoPassword, trust, mapped);
      throw e;
    }
  }
  private useSudo = true;
  private async readContentRoles(profile: AdminProfile): Promise<{ id: string; name: string }[]> {
    // This root-owned, non-writable manifest is only an entry-point assignment.
    // Filesystem permissions still govern all actual access. No client role flag grants sudo.
    return new Promise(resolve => {
      let done = false; let channel: import('ssh2').SFTPWrapper | undefined;
      const finish = (roles: { id: string; name: string }[]) => { if (done) return; done = true; clearTimeout(timer); channel?.end(); resolve(roles); };
      const timer = setTimeout(() => finish([]), 10000);
      this.client!.sftp(async (error, sftp) => {
        if (error) { finish([]); return; } channel = sftp;
        if (done) { sftp.end(); return; }
        for (const base of ['', profile.root]) {
          try {
            for (const file of [base || '/', base + '/.workbench', base + '/.workbench/roles.json']) {
              const stat = await new Promise<import('ssh2').Stats>((resolve, reject) => sftp.lstat(file, (e, value) => e ? reject(e) : resolve(value)));
              if (stat.uid !== 0 || (stat.mode & 0o022) || stat.isSymbolicLink()) throw new Error('角色文件权限不可信');
              if (file.endsWith('.json') && (!stat.isFile() || stat.size > 256 * 1024)) throw new Error('角色文件异常');
            }
            const data = await new Promise<Buffer>((resolve, reject) => sftp.readFile(base + '/.workbench/roles.json', (e, buffer) => e ? reject(e) : resolve(buffer)));
            const manifest = JSON.parse(data.toString('utf8'));
            if (manifest.version !== 1 || manifest.root !== profile.root) continue;
            const roles = manifest.users?.[profile.username]?.contentGroups;
            if (Array.isArray(roles) && roles.every(g => typeof g.id === 'string' && typeof g.name === 'string')) { finish(roles); return; }
          } catch {}
        }
        finish([]);
      });
    });
  }
  private simple(command: string) {
    return new Promise<string>((resolve, reject) => {
      let channel: ClientChannel | undefined;
      const timer = setTimeout(() => { channel?.close(); reject(new Error('此账号未取得管理员或项目组管理员资格；请由总管理员分配权限')); }, 15000);
      this.client!.exec(command, (error, stream) => {
        if (error) { clearTimeout(timer); reject(error); return; }
        channel = stream;
        let output = ''; stream.on('data', (data: Buffer) => output += data.toString());
        stream.on('error', reject); stream.on('close', (code: number) => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error('该账号不能执行 SSH 管理命令，请使用已有 root 或 sudo 管理账号')); });
      });
    });
  }
  private execute(payload: object, useSudo: boolean, signal?: AbortSignal, timeoutMs = 90000): Promise<any> {
    if (!this.rawReady || !this.client) return Promise.reject(new Error('请先连接服务器'));
    if (signal?.aborted) return Promise.reject(new Error('已取消空间统计'));
    // Only a small fixed loader goes in the SSH exec request. The packaged
    // program travels over stdin so feature growth cannot exceed packet limits.
    const program = `python3 -u -c 'import sys,base64,zlib;print("WORKBENCH_CODE_READY",flush=True);exec(zlib.decompress(base64.b64decode(sys.stdin.readline())).decode("utf-8"))'`;
    const command = useSudo ? 'sudo -S -p WORKBENCH_SUDO -- ' + program : program;
    const request = { ...payload, root: this.snapshot.profile!.root };
    return new Promise((resolve, reject) => {
      let channel: ClientChannel | undefined, settled = false, buffer = '', diagnostic = '', ready = false, codeSent = false, passwordSent = false;
      const abort = () => { channel?.close(); finish(new Error('已取消空间统计')); };
      const finish = (error?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); channel?.end(); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { channel?.close(); finish(new Error('远端命令超时；可能已部分执行，请刷新状态后再决定是否重试')); }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      this.client!.exec(command, (error, stream) => {
        if (error) { finish(error); return; } channel = stream; stream.setEncoding('utf8'); stream.stderr.setEncoding('utf8');
        stream.stderr.on('data', (data: Buffer) => {
          diagnostic = (diagnostic + data.toString()).slice(-3000);
          if (diagnostic.includes('WORKBENCH_SUDO')) {
            if (passwordSent) { finish(new Error('sudo 验证失败，请检查管理员权限和提权密码')); stream.close(); return; }
            passwordSent = true; diagnostic = ''; stream.write(this.sudoPassword + '\n');
          }
        });
        stream.on('data', (data: string) => {
          buffer += data;
          if (buffer.length > 4 * 1024 * 1024) { finish(new Error('远端响应超出限制')); stream.close(); return; }
          let end: number;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
            if (!codeSent && line === 'WORKBENCH_CODE_READY') { codeSent = true; stream.write(this.code + '\n'); }
            else if (codeSent && !ready && line === 'WORKBENCH_READY') { ready = true; stream.write(JSON.stringify(request) + '\n'); }
            else if (ready && line) { try { const message = JSON.parse(line); message.ok ? finish(undefined, message.value) : finish(new Error(message.error)); } catch { finish(new Error('远端返回格式异常')); } }
          }
        });
        stream.on('error', finish); stream.on('close', () => { if (!settled) finish(new Error('远端管理命令未完成。请确认 Linux 已安装 Python 3、账号有 SSH 命令与 sudo 权限。\n' + diagnostic)); });
      });
    });
  }
  async operation(payload: AdminOperation) {
    if (!this.snapshot.verified || this.snapshot.role !== 'administrator') throw new Error('只有总管理员可以管理用户和用户组');
    if (this.snapshot.busy) throw new Error('已有管理操作正在执行，请等待结果');
    this.snapshot.busy = true; this.changed();
    try {
      if (payload.op === 'status') {
        const probe = await this.execute({ op: 'probe' }, this.useSudo);
        Object.assign(this.snapshot, { missingCommands: probe.missingCommands, setupIssues: probe.setupIssues, setupNotes: probe.setupNotes, aclBackend: probe.aclBackend, serviceManager: probe.serviceManager });
      }
      const result = await this.execute(payload, this.useSudo, undefined, payload.op === 'environment_prepare' ? 25 * 60 * 1000 : 90000);
      if (payload.op === 'environment_prepare') {
        Object.assign(this.snapshot, result.environment);
        this.snapshot.state = await this.execute({ op: 'status' }, this.useSudo);
      } else this.snapshot.state = payload.op === 'status' ? result : result.state;
      return result;
    }
    catch (error) {
      // The server may have completed only some steps. Refresh before offering recovery.
      try {
        const probe = await this.execute({ op: 'probe' }, this.useSudo);
        Object.assign(this.snapshot, { missingCommands: probe.missingCommands, setupIssues: probe.setupIssues, setupNotes: probe.setupNotes, aclBackend: probe.aclBackend, serviceManager: probe.serviceManager });
        this.snapshot.state = await this.execute({ op: 'status' }, this.useSudo);
      } catch { this.snapshot.state = undefined; }
      throw error;
    }
    finally { this.snapshot.busy = false; this.changed(); }
  }
  async storageUsage(raw: StorageScanRequest, signal?: AbortSignal): Promise<StorageUsageReport> {
    const request = storageScanSchema.parse(raw);
    if (!this.snapshot.verified || this.snapshot.role !== 'administrator') throw new Error('只有总管理员可以查看共享空间统计');
    if (!this.snapshot.state?.initialized) throw new Error('请先初始化团队空间');
    return await this.execute({ op: 'storage_usage', ...request }, this.useSudo, signal, 5 * 60 * 1000) as StorageUsageReport;
  }
}
