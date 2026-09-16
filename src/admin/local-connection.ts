import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { AdminOperation, AdminProfile, AdminSnapshot } from './types';
import { adminOperationSchema, nameSchema } from './types';
import { diskPath, localRoot, passwordHash, passwordMatches, readRegistry, registryLock, writeRegistry, type LocalRegistry } from '../core/local-space';

export class LocalAdminConnection {
  snapshot: AdminSnapshot = { connected: false, verified: false, busy: false };
  private root = ''; private proof = ''; private generation = 0;
  constructor(private changed: () => void) {}
  disconnect() { this.generation++; this.proof = ''; this.snapshot = { profile: this.snapshot.profile, connected: false, verified: false, busy: false }; this.changed(); }
  async connect(profile: AdminProfile, password: string, _sudo: string, _trust: (s: string) => Promise<boolean>) {
    this.disconnect(); this.root = await localRoot(profile.localRoot);
    nameSchema.parse(profile.username);
    if (password.length < 8) throw new Error('本地测试密码至少 8 位');
    let data: LocalRegistry | undefined;
    try { data = await readRegistry(this.root); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    if (data) {
      if (!passwordMatches(password, data.credentials[profile.username])) throw new Error('模拟账号或密码错误');
      if (data.administrator !== profile.username) throw new Error('本地管理员版只允许此共享区的模拟管理员登录；项目子管理员请使用用户版');
      this.proof = data.credentials[profile.username];
    } else {
      if ((await fs.readdir(this.root)).length) throw new Error('首次初始化必须使用专用空目录');
      this.proof = passwordHash(password);
    }
    const saved = { ...profile, host: 'local', localRoot: this.root, fingerprint: data ? 'LOCAL:' + data.state.teamId : '', mode: 'local' as const };
    this.snapshot = { profile: saved, connected: true, verified: true, busy: false, actor: profile.username, role: 'administrator', state: data?.state || { initialized: false, users: {}, groups: {} } };
    this.changed(); return saved;
  }
  async operation(raw: AdminOperation) {
    const request = adminOperationSchema.parse(raw);
    if (!this.snapshot.connected || !this.proof) throw new Error('请先连接本地共享区');
    if (this.snapshot.busy) throw new Error('请等待当前管理操作完成');
    const generation = this.generation;
    this.snapshot.busy = true; this.changed();
    try {
      return await registryLock(this.root, async () => {
        let data: LocalRegistry;
        try { data = await readRegistry(this.root); }
        catch (e: any) {
          if (e.code !== 'ENOENT') throw e;
          if (request.op === 'status') return this.snapshot.state;
          if (request.op !== 'initialize') throw new Error('请先初始化账号管理');
          if ((await fs.readdir(this.root)).some(s => s !== '.workbench-local.lock')) throw new Error('共享区不是空目录，不能初始化');
          data = { version: 1, administrator: this.snapshot.profile!.username, credentials: { [this.snapshot.profile!.username]: this.proof }, state: { initialized: true, teamId: randomUUID(), loginGroup: 'local_members', sftpConfigured: true, users: {}, groups: {}, operations: {} } };
          await fs.mkdir(await diskPath(this.root, '/.workbench-local', true));
          await fs.mkdir(await diskPath(this.root, '/projects', true));
        }
        if (data.administrator !== this.snapshot.profile!.username || data.credentials[data.administrator] !== this.proof || generation !== this.generation) throw new Error('模拟管理员身份已改变，请重新连接');
        const state = data.state;
        const user = 'username' in request ? state.users[request.username] : undefined;
        if (['user_password', 'user_enabled', 'user_groups', 'group_member'].includes(request.op) && !user) throw new Error('成员不存在');
        if (request.op === 'user_create' || request.op === 'user_groups') {
          const groups = request.groups || [], admins = request.contentAdminGroups || [];
          if (groups.some(g => !state.groups[g]?.workspace) || admins.some(g => !groups.includes(g))) throw new Error('项目组不存在或子管理员未加入该组');
        }
        switch (request.op) {
          case 'status': break;
          case 'initialize': break;
          case 'configure_sftp': state.sftpConfigured = true; break;
          case 'group_create': {
            const name = 'local_' + request.label;
            if (state.groups[name]) throw new Error('项目组已存在');
            const workspace = '/projects/' + request.label;
            await fs.mkdir(await diskPath(this.root, workspace, true));
            state.groups[name] = { name, label: request.label, adminGroup: name + '_admins', workspace }; break;
          }
          case 'workspace_prepare': if (!state.groups[request.group]?.workspace) throw new Error('项目组不存在'); break;
          case 'user_create':
            if (state.users[request.username] || data.administrator === request.username) throw new Error('账号已存在');
            state.users[request.username] = { username: request.username, name: request.name, enabled: true, groups: request.groups || [], contentAdminGroups: request.contentAdminGroups || [] };
            data.credentials[request.username] = passwordHash(request.password); break;
          case 'user_password': data.credentials[request.username] = passwordHash(request.password); break;
          case 'user_enabled': user!.enabled = request.enabled; break;
          case 'user_groups': user!.groups = request.groups; user!.contentAdminGroups = request.contentAdminGroups; break;
          case 'group_member': {
            const group = state.groups[request.group];
            if (!group?.workspace || group.provisioning) throw new Error('项目组不存在或工作目录尚未准备好');
            if (user!.provisioning || user!.missing) throw new Error('请先完成用户开通或核对账号身份');
            const groups = new Set(user!.groups || []), admins = new Set(user!.contentAdminGroups || []);
            if (request.role === 'remove') groups.delete(request.group); else groups.add(request.group);
            if (request.role === 'admin') admins.add(request.group); else admins.delete(request.group);
            user!.groups = [...groups]; user!.contentAdminGroups = [...admins]; break;
          }
          case 'recover': throw new Error('本地权限桩没有 Linux 命令恢复任务');
        }
        if (request.op !== 'status') {
          const id = randomUUID(); const { password: _secret, ...sanitized } = request as any;
          state.operations ||= {}; state.operations[id] = { id, op: request.op, request: sanitized, status: 'done', completed: ['本地权限桩已保存'] };
          await writeRegistry(this.root, data);
        }
        this.snapshot.state = state; this.snapshot.profile!.fingerprint = 'LOCAL:' + state.teamId; return state;
      });
    } finally { this.snapshot.busy = false; this.changed(); }
  }
}
