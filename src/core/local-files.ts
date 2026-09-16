import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectionProfile, FilePreview, Project, RemoteBinding, RemoteEntry, WorkspaceAccess } from '../shared/types';
import { authorizeUser, diskPath, localRoot, passwordMatches, readRegistry } from './local-space';
import { assertRemote, childRemote, remotePath, withinRemote } from './paths';
import { newProjectLayout, projectName } from './project-layout';
import { sameEndpoint } from './sftp';

export class LocalFileConnection {
  profile?: ConnectionProfile; workspace?: WorkspaceAccess;
  private root = ''; private proof = ''; private ready = false;
  constructor(private changed: () => void = () => {}) {}
  get connected() { return this.ready; }
  disconnect() { this.ready = false; this.proof = ''; this.workspace = undefined; this.changed(); }
  async connect(profile: ConnectionProfile, password: string, _trust: (s: string) => Promise<boolean>) {
    this.disconnect(); this.root = await localRoot(profile.localRoot);
    const data = await readRegistry(this.root);
    if (!passwordMatches(password, data.credentials[profile.username])) throw new Error('模拟账号或密码错误');
    const proof = data.credentials[profile.username]; authorizeUser(data, profile.username, proof);
    const fingerprint = 'LOCAL:' + data.state.teamId;
    if (profile.fingerprint && profile.fingerprint !== fingerprint) throw new Error('本地共享区身份已改变，请导入此共享区的成员配置');
    this.profile = { ...profile, mode: 'local', localRoot: this.root, host: 'local', port: 22, fingerprint, projects: [] };
    this.proof = proof; this.ready = true; this.changed(); return this.profile;
  }
  channel(binding?: RemoteBinding) {
    if (!this.ready || !this.profile) throw new Error('请先连接本地共享区');
    if (binding) {
      if (!sameEndpoint(binding, this.profile)) throw new Error('当前共享区或账号与任务绑定的身份不一致');
      const p = this.profile.projects.find(p => p.id === binding.project.id);
      if (!p || ['remoteRoot', 'uploadPath', 'historyPath'].some(k => p[k as keyof Project] !== binding.project[k as keyof Project])) throw new Error('项目入口配置已改变');
    }
    return this;
  }
  private async access(target: string, create = false) {
    const connection = this.channel(), proof = this.proof, profile = this.profile!;
    const data = await readRegistry(this.root);
    if (connection !== this.channel() || proof !== this.proof || profile !== this.profile) throw new Error('连接已改变');
    const user = authorizeUser(data, profile.username, proof);
    const group = Object.values(data.state.groups).find(g => g.workspace && withinRemote(g.workspace, target));
    if (!group || !user.groups?.includes(group.name)) throw new Error('模拟权限拒绝：不属于此项目组');
    if (create && !user.contentAdminGroups?.includes(group.name)) throw new Error('当前账号不是此工作路径的项目子管理员');
    return { user, group };
  }
  binding(id: string): RemoteBinding {
    const p = this.channel().profile!, project = p.projects.find(x => x.id === id);
    if (!project) throw new Error('项目入口不存在');
    return { connectionId: p.id, host: p.host, port: p.port, username: p.username, fingerprint: p.fingerprint, project: structuredClone(project) };
  }
  async verifyDirectory(target: string) {
    target = remotePath(target); await this.access(target);
    if (!(await fs.stat(await diskPath(this.root, target))).isDirectory()) throw new Error('工作路径必须是目录');
    return { path: target, canonicalPath: target };
  }
  async verifyWorkspace(target: string): Promise<WorkspaceAccess> {
    const checked = await this.verifyDirectory(target), { user, group } = await this.access(target);
    this.workspace = { ...checked, canCreateProject: group.workspace === checked.path && !!user.contentAdminGroups?.includes(group.name), groupName: group.name };
    this.profile!.workPath = checked.path; this.changed(); return this.workspace;
  }
  private personal(p: Project): Project { return { ...p, managed: true, uploadPath: childRemote(p.remoteRoot, 'submissions') + '/' + this.profile!.username, historyPath: p.remoteRoot + '/trajectories/' + this.profile!.username }; }
  private async readProject(root: string): Promise<Project | undefined> {
    const filename = root + '/.workbench-project.json';
    try {
      const file = await diskPath(this.root, filename), stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 16384) return;
      const meta = JSON.parse(await fs.readFile(file, 'utf8'));
      if (meta.version !== 1 || !/^project_[a-f0-9]{32}$/.test(meta.id)) return;
      return this.personal({ id: meta.id, name: projectName(meta.name), remoteRoot: root, uploadPath: root, historyPath: root });
    } catch (e: any) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return; throw e; }
  }
  async discoverProjects() {
    const base = this.workspace?.canonicalPath; if (!base) throw new Error('请先验证共享工作路径');
    await this.verifyWorkspace(base);
    const current = await this.readProject(base), projects: Project[] = [];
    if (current) projects.push(current);
    else {
      const entries = await fs.readdir(await diskPath(this.root, base), { withFileTypes: true });
      if (entries.length > 500) throw new Error('目录数量超过 500，请选择更具体的工作路径');
      for (const e of entries) if (!e.name.startsWith('.') && e.isDirectory() && !e.isSymbolicLink()) { const p = await this.readProject(childRemote(base, e.name)); if (p) projects.push(p); }
    }
    this.channel().profile!.projects = projects; this.changed(); return projects;
  }
  loadManifest() { return this.discoverProjects(); }
  async createProject(name: string) {
    const base = this.workspace?.canonicalPath; if (!base) throw new Error('请先验证共享工作路径');
    const { group } = await this.access(base, true);
    if (base !== group.workspace) throw new Error('只能在项目组工作路径中创建项目');
    const project = newProjectLayout(base, name), root = await diskPath(this.root, project.remoteRoot, true);
    await fs.mkdir(root); // Exclusive reservation; a duplicate never overwrites.
    await fs.mkdir(path.join(root, 'trajectories')); await fs.mkdir(path.join(root, 'submissions'));
    await fs.writeFile(path.join(root, '.workbench-project.json'), JSON.stringify({ version: 1, id: project.id, name: project.name, createdBy: this.profile!.username, createdAt: new Date().toISOString() }), { flag: 'wx' });
    const p = this.personal(project); this.profile!.projects.push(p); this.changed(); return p;
  }
  private async checked(binding: RemoteBinding, target: string, write = false, missing = false) {
    this.channel(binding); target = assertRemote(binding.project.remoteRoot, target); await this.access(target);
    const p = binding.project, suffix = target.slice(p.remoteRoot.length).split('/').filter(Boolean), user = this.profile!.username;
    if (suffix.some(s => s.startsWith('.'))) throw new Error('模拟权限拒绝：管理记录不可操作');
    if ((suffix[0] === 'trajectories' && suffix[1] && suffix[1] !== user) || (write && ['trajectories', 'submissions'].includes(suffix[0]) && suffix[1] !== user)) throw new Error('模拟权限拒绝：不能访问他人私有轨迹或修改他人成果');
    const marker = await this.readProject(p.remoteRoot);
    if (!marker || marker.id !== p.id) throw new Error('项目身份已改变');
    const file = await diskPath(this.root, target, missing); this.channel(binding); return file;
  }
  async ensurePersonalFolder(binding: RemoteBinding, target: string) {
    if (![binding.project.uploadPath, binding.project.historyPath].includes(target)) { await this.checked(binding, target, true); return; }
    const dir = await this.checked(binding, target, true, true); await fs.mkdir(dir, { recursive: true });
  }
  async list(binding: RemoteBinding, target: string): Promise<RemoteEntry[]> {
    const dir = await this.checked(binding, target), entries = await fs.readdir(dir, { withFileTypes: true }), result: RemoteEntry[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (target === binding.project.remoteRoot + '/trajectories' && e.name !== binding.username) continue;
      const stat = await fs.lstat(path.join(dir, e.name));
      result.push({ name: e.name, path: childRemote(target, e.name), kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file', size: stat.size, modified: stat.mtimeMs });
    }
    return result.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
  }
  async preview(binding: RemoteBinding, target: string): Promise<FilePreview> {
    const file = await this.checked(binding, target), stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('只能预览普通文件');
    const name = path.posix.basename(target), ext = path.extname(name).toLowerCase();
    const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    const limit = mime[ext] && stat.size <= 5 * 1024 * 1024 ? 5 * 1024 * 1024 : 512 * 1024;
    const handle = await fs.open(file, 'r'); let data: Buffer;
    try { const buffer = Buffer.alloc(Math.min(stat.size, limit)); const { bytesRead } = await handle.read(buffer); data = buffer.subarray(0, bytesRead); } finally { await handle.close(); }
    await this.checked(binding, target);
    const type = mime[ext] && stat.size <= limit ? 'image' : data.includes(0) || ['.zip', '.pdf', '.exe', '.docx', '.xlsx'].includes(ext) ? 'binary' : 'text';
    return { name, path: target, type, content: type === 'image' ? `data:${mime[ext]};base64,${data.toString('base64')}` : type === 'text' ? data.toString('utf8') : '', size: stat.size, truncated: stat.size > limit };
  }
  async download(binding: RemoteBinding, target: string, local: string, progress = (_bytes: number, _total: number) => {}) {
    const file = await this.checked(binding, target), stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('只能下载普通文件');
    await fs.mkdir(path.dirname(local), { recursive: true }); const temp = local + '.' + randomUUID() + '.partial';
    try { await fs.copyFile(file, temp, fs.constants.COPYFILE_EXCL); await this.checked(binding, target); await fs.rename(temp, local); progress(stat.size, stat.size); }
    finally { await fs.rm(temp, { force: true }); }
  }
  async upload(binding: RemoteBinding, local: string, target: string, progress: (bytes: number, total: number) => void) {
    const file = await this.checked(binding, target, true, true), stat = await fs.lstat(local);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('只能上传普通文件');
    const temp = path.join(path.dirname(file), '.' + randomUUID() + '.uploading');
    try {
      await fs.copyFile(local, temp, fs.constants.COPYFILE_EXCL); await this.checked(binding, target, true, true);
      // link publishes without ever replacing an existing contribution.
      await fs.link(temp, file); progress(stat.size, stat.size);
    } finally { await fs.rm(temp, { force: true }); }
  }
}
