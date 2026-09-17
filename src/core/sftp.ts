import { Client, type SFTPWrapper, type Stats } from 'ssh2';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import type { ConnectionProfile, FilePreview, Project, RemoteBinding, RemoteEntry, WorkspaceAccess } from '../shared/types';
import { assertRemote, childRemote, remotePath, withinRemote } from './paths';
import { systemUsername } from './account-login';
import { newProjectLayout, projectName } from './project-layout';
import { PROJECT_BRIEF_FILE, projectBriefSchema, projectBriefMarkdown, type ProjectBrief } from '../shared/project-brief';
const MAX_PREVIEW = 512 * 1024;
export function sameEndpoint(a: RemoteBinding, b: ConnectionProfile): boolean {
  return a.connectionId === b.id && a.host === b.host && a.port === b.port && a.username === b.username && a.fingerprint === b.fingerprint;
}
export function friendlySftp(error: any): Error {
  if (error.code === 3) return new Error('Linux 拒绝访问：当前账号没有此目录或文件的权限');
  if (error.code === 2) return new Error('远端路径不存在，请核对管理员提供的 SFTP 路径');
  return new Error(error.message || String(error));
}
export class SftpConnection {
  private client?: Client; private sftp?: SFTPWrapper;
  profile?: ConnectionProfile;
  workspace?: WorkspaceAccess; workspaces: WorkspaceAccess[] = [];
  constructor(private changed: () => void = () => {}) {}
  get connected() { return !!this.sftp; }
  async connect(profile: ConnectionProfile, password: string, trust: (fingerprint: string) => Promise<boolean>) {
    this.disconnect();
    const client = new Client(); this.client = client;
    let fingerprint = '';
    await new Promise<void>((resolve, reject) => {
      client.on('error', reject);
      client.on('close', () => { if (this.client === client) { this.sftp = undefined; this.workspace = undefined; this.workspaces = []; this.changed(); } });
      client.on('ready', () => client.sftp((error, channel) => {
        if (error) { reject(error); return; }
        this.sftp = channel; this.profile = { ...profile, fingerprint, projects: [], workPath: '', manifestPath: '' }; resolve(); this.changed();
      }));
      client.connect({ host: profile.host, port: profile.port, username: systemUsername(profile.username), password, readyTimeout: 30000, keepaliveInterval: 15000,
        hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
          fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          if (profile.fingerprint) { callback(profile.fingerprint === fingerprint); return; }
          trust(fingerprint).then(callback, () => callback(false));
        }
      });
    }).catch(e => { client.end(); throw friendlySftp(e); });
    return this.profile!;
  }
  disconnect() { this.workspace = undefined; this.workspaces = []; this.sftp = undefined; this.client?.end(); this.client = undefined; this.changed(); }
  channel(binding?: RemoteBinding) {
    if (!this.sftp || !this.profile) throw new Error('请先连接共享服务器');
    if (binding && !sameEndpoint(binding, this.profile)) throw new Error('当前服务器或账号与任务绑定的身份不一致，请切回原连接后重试');
    if (binding) {
      const project = this.profile.projects.find(p => p.id === binding.project.id);
      if (!project || project.remoteRoot !== binding.project.remoteRoot || project.uploadPath !== binding.project.uploadPath || project.historyPath !== binding.project.historyPath) throw new Error('项目入口配置已改变，请重新选择项目并创建上传任务');
    }
    return this.sftp;
  }
  binding(projectId: string): RemoteBinding {
    this.channel(); const p = this.profile!;
    const project = p.projects.find(x => x.id === projectId); if (!project) throw new Error('项目入口不存在');
    return { connectionId: p.id, host: p.host, port: p.port, username: p.username, fingerprint: p.fingerprint, project: structuredClone(project) };
  }
  async verifyDirectory(target: string): Promise<{ path: string; canonicalPath: string }> {
    const s = this.channel(), requested = remotePath(target);
    const canonicalPath = await this.real(s, requested);
    const info = await this.stat(s, canonicalPath);
    if (!info.isDirectory()) throw new Error('工作路径必须是服务器上已经存在的目录');
    // Exercise the server's permission checks, including ACLs, instead of
    // inferring effective access from permission bits supplied by stat.
    await new Promise<void>((resolve, reject) => s.stat(canonicalPath.replace(/\/$/, '') + '/.', error => error ? reject(friendlySftp(error)) : resolve()));
    await new Promise<void>((resolve, reject) => s.opendir(canonicalPath, (error, handle) => {
      if (error) { reject(friendlySftp(error)); return; }
      s.close(handle, closeError => closeError ? reject(friendlySftp(closeError)) : resolve());
    }));
    if (this.channel() !== s) throw new Error('验证期间服务器连接已改变，请重新验证工作路径');
    return { path: requested, canonicalPath };
  }
  private async assignedWorkspaces(): Promise<WorkspaceAccess[]> {
    const s = this.channel(), username = this.profile!.username;
    const file = '/.workbench/roles.json';
    try {
      for (const target of ['/', '/.workbench', file]) {
        const info = await this.stat(s, target);
        if (info.uid !== 0 || info.mode & 0o022 || info.isSymbolicLink() || (target === file && (!info.isFile() || info.size > 256 * 1024))) throw new Error('不可信的工作组记录');
      }
      const data = await this.readLimited(s, file, 256 * 1024);
      if (data.truncated) throw new Error('工作组记录过大');
      const roles = JSON.parse(data.buffer.toString('utf8'));
      if (roles.version !== 1 || roles.membershipVersion !== 1) throw new Error('请管理员使用新版管理员端刷新成员信息');
      const user = Object.hasOwn(roles.users || {}, username) ? roles.users[username] : undefined;
      if (!user) throw new Error('当前账号未启用或不属于此团队，请联系管理员');
      if (!Array.isArray(user.groups) || user.groups.length > 200) throw new Error('工作组记录格式无效');
      const seen = new Set<string>(), roots = new Set<string>();
      return user.groups.map((g: any) => {
        if (typeof g.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(g.id) || typeof g.name !== 'string' || !g.name || g.name.length > 160 || (g.workspace !== null && g.workspace !== undefined && (typeof g.workspace !== 'string' || !/^\/projects\/[a-z][a-z0-9_-]{0,13}$/.test(g.workspace))) || seen.has(g.id) || (g.workspace && roots.has(g.workspace))) throw new Error('工作组记录格式无效');
        seen.add(g.id); if (g.workspace) roots.add(g.workspace);
        return { groupName: g.id, groupLabel: g.name, path: g.workspace || '', canonicalPath: g.workspace || '', canCreateProject: !!g.workspace && Array.isArray(user.contentGroups) && user.contentGroups.some((a: any) => a.id === g.id && a.workspace === g.workspace), ...(!g.workspace ? { accessError: '管理员尚未完成工作组目录配置' } : {}) };
      });
    } catch (e: any) { throw new Error('无法读取账号的工作组信息：' + e.message); }
  }
  async verifyWorkspace(target: string): Promise<WorkspaceAccess> {
    const s = this.channel(), assigned = await this.assignedWorkspaces(), workspace = assigned.find(w => w.path === target);
    if (!workspace) throw new Error('共享工作路径由所属工作组分配，当前账号未加入此组');
    const checked = await this.verifyDirectory(target);
    if (checked.canonicalPath !== workspace.path) throw new Error('工作组目录不能指向其他路径');
    if (this.channel() !== s) throw new Error('验证期间服务器连接已改变');
    this.workspace = { ...workspace, ...checked }; this.changed(); return this.workspace;
  }
  private projectForUser(project: Project): Project {
    const username = this.profile!.username;
    return { ...project, managed: true, uploadPath: childRemote(childRemote(project.remoteRoot, 'submissions'), username), historyPath: childRemote(childRemote(project.remoteRoot, 'trajectories'), username) };
  }
  private async readProject(root: string, workspace?: WorkspaceAccess): Promise<Project | undefined> {
    const s = this.channel();
    try {
      const canonical = await this.real(s, root);
      if (canonical !== root) return undefined;
      const marker = childRemote(root, '.workbench-project.json');
      const info = await this.stat(s, marker);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) return undefined;
      const data = await this.readLimited(s, marker, 16 * 1024); if (data.truncated) return undefined;
      const meta = JSON.parse(data.buffer.toString('utf8'));
      if (meta.version !== 1 || !/^project_[a-f0-9]{32}$/.test(meta.id)) return undefined;
      return this.projectForUser({ id: meta.id, name: projectName(meta.name), remoteRoot: root, uploadPath: root, historyPath: childRemote(root, 'trajectories'), groupName: workspace?.groupName, groupLabel: workspace?.groupLabel });
    } catch (error: any) { if (error instanceof SyntaxError || error.code === 2 || /不存在|拒绝访问|项目名/.test(error.message)) return undefined; throw error; }
  }
  async discoverProjects(): Promise<Project[]> {
    const s = this.channel(), profile = this.profile!;
    let workspaces: WorkspaceAccess[];
    try { workspaces = await this.assignedWorkspaces(); }
    catch (e) { if (this.profile === profile) { this.workspaces = []; this.workspace = undefined; profile.projects = []; this.changed(); } throw e; }
    const projects: Project[] = [];
    for (const workspace of workspaces) {
      if (workspace.accessError) continue;
      try {
        const checked = await this.verifyDirectory(workspace.path);
        if (checked.canonicalPath !== workspace.path) throw new Error('工作组目录不能指向其他路径');
        const entries = await new Promise<import('ssh2').FileEntry[]>((resolve, reject) => s.readdir(workspace.path, (e, list) => e ? reject(friendlySftp(e)) : resolve(list)));
        workspace.isEmpty = entries.every(e => e.filename === '.' || e.filename === '..');
        const directories = entries.filter(e => !e.filename.startsWith('.') && (e.attrs.mode & 0o170000) === 0o040000);
        if (directories.length > 500) throw new Error('工作组目录超过 500 项，请联系管理员整理');
        const found: Project[] = [];
        for (const entry of directories) { const project = await this.readProject(childRemote(workspace.path, entry.filename), workspace); if (project) found.push(project); }
        projects.push(...found);
      } catch (e: any) { workspace.accessError = e.message; workspace.canCreateProject = false; }
    }
    if (this.channel() !== s || this.profile !== profile) throw new Error('刷新期间连接已改变');
    this.workspaces = workspaces; this.workspace = workspaces[0]; profile.projects = projects; profile.workPath = ''; profile.manifestPath = '';
    for (const project of projects) {
      let exists = false;
      try { await this.stat(s, project.uploadPath); exists = true; } catch (e: any) { if (!/不存在/.test(e.message)) continue; }
      if (exists) await this.ensurePersonalFolder(this.binding(project.id), project.uploadPath);
    }
    this.changed(); return projects;
  }
  async createProject(name: string, groupName?: string, rawBrief?: ProjectBrief): Promise<Project> {
    const brief = rawBrief === undefined ? undefined : projectBriefSchema.parse(rawBrief);
    await this.loadManifest();
    const s = this.channel(), workspace = groupName ? this.workspaces.find(w => w.groupName === groupName) : this.workspaces.length === 1 ? this.workspaces[0] : undefined;
    if (!workspace) throw new Error(this.workspaces.length ? '请选择要创建项目的工作组' : '还没有加入工作组，请联系管理员');
    if (workspace.accessError) throw new Error(workspace.accessError);
    if (!workspace.canCreateProject) throw new Error('当前账号不是此工作组的项目子管理员');
    const base = workspace.canonicalPath;
    const project = newProjectLayout(base, name), directories: string[] = [];
    const marker = childRemote(project.remoteRoot, '.workbench-project.json'), briefPath = childRemote(project.remoteRoot, PROJECT_BRIEF_FILE), files: string[] = []; let completed = false;
    const mkdir = (target: string, mode: number) => new Promise<void>((resolve, reject) => s.mkdir(target, { mode }, e => e ? reject(friendlySftp(e)) : resolve()));
    const write = async (target: string, text: string) => {
      const handle = await new Promise<Buffer>((resolve, reject) => s.open(target, 'wx', { mode: 0o640 }, (e, handle) => e ? reject(friendlySftp(e)) : resolve(handle)));
      files.push(target); const buffer = Buffer.from(text, 'utf8');
      try { await new Promise<void>((resolve, reject) => s.write(handle, buffer, 0, buffer.length, 0, e => e ? reject(friendlySftp(e)) : resolve())); }
      finally { await new Promise<void>((resolve, reject) => s.close(handle, e => e ? reject(friendlySftp(e)) : resolve())); }
    };
    try {
      // Exclusive mkdir reserves the name. Other members cannot enter until the final chmod.
      await mkdir(project.remoteRoot, 0o2700); directories.push(project.remoteRoot);
      for (const folder of ['trajectories', 'submissions']) { const dir = childRemote(project.remoteRoot, folder); await mkdir(dir, 0o3770); directories.push(dir); }
      if (brief) await write(briefPath, projectBriefMarkdown(project.name, brief, this.profile!.username, new Date().toISOString()));
      await write(marker, JSON.stringify({ version: 1, id: project.id, name: project.name, createdBy: this.profile!.username, createdAt: new Date().toISOString() }, null, 2));
      if (this.channel() !== s) throw new Error('创建期间连接已改变');
      await new Promise<void>((resolve, reject) => s.chmod(project.remoteRoot, 0o2770, e => e ? reject(friendlySftp(e)) : resolve())); completed = true;
      workspace.isEmpty = false;
      const result = this.projectForUser({ ...project, groupName: workspace.groupName, groupLabel: workspace.groupLabel }); this.profile!.projects.push(result); this.changed(); return result;
    } catch (error: any) {
      // Only remove paths reserved by this attempt, and only if still empty.
      if (!completed) {
        for (const file of files.reverse()) await new Promise<void>(r => s.unlink(file, () => r()));
        for (const dir of directories.reverse()) await new Promise<void>(r => s.rmdir(dir, () => r()));
      }
      throw new Error('项目未创建成功（同名目录不会覆盖）：' + error.message);
    }
  }
  async ensurePersonalFolder(binding: RemoteBinding, target: string) {
    const s = this.channel(binding);
    if (!binding.project.managed || ![binding.project.uploadPath, binding.project.historyPath].includes(target)) return;
    await this.checked(binding, target, true);
    try { await new Promise<void>((resolve, reject) => s.mkdir(target, { mode: target === binding.project.uploadPath ? 0o2750 : 0o700 }, e => e ? reject(e) : resolve())); }
    catch (error) { try { const info = await this.stat(s, target); if (!info.isDirectory() || info.isSymbolicLink()) throw error; } catch { throw friendlySftp(error); } }
    // Repair the current user's legacy 0700 submissions directory on the next upload.
    // chmod also limits inherited ACL masks; trajectories retain their private mask.
    await new Promise<void>((resolve, reject) => s.chmod(target, target === binding.project.uploadPath ? 0o2750 : 0o700, e => e ? reject(friendlySftp(e)) : resolve()));
    if (target === binding.project.uploadPath) {
      const owner = (await this.stat(s, target)).uid;
      const files = await new Promise<import('ssh2').FileEntry[]>((resolve, reject) => s.readdir(target, (e, files) => e ? reject(e) : resolve(files)));
      for (const file of files) {
        if (file.filename === '.' || file.filename === '..') continue;
        const filename = childRemote(target, file.filename), info = await this.stat(s, filename);
        if (info.isFile() && !info.isSymbolicLink() && info.uid === owner) await new Promise<void>((resolve, reject) => s.chmod(filename, 0o640, e => e ? reject(e) : resolve()));
      }
    }
    await this.verifyDirectory(target); this.channel(binding);
  }
  private real(s: SFTPWrapper, target: string): Promise<string> { return new Promise((resolve, reject) => s.realpath(target, (e, result) => e ? reject(friendlySftp(e)) : resolve(result))); }
  private stat(s: SFTPWrapper, target: string): Promise<Stats> { return new Promise((resolve, reject) => s.lstat(target, (e, result) => e ? reject(friendlySftp(e)) : resolve(result))); }
  async checked(binding: RemoteBinding, target: string, parent = false) {
    const s = this.channel(binding); const p = assertRemote(binding.project.remoteRoot, target);
    const canonicalRoot = await this.real(s, binding.project.remoteRoot);
    const canonicalTarget = await this.real(s, parent ? path.posix.dirname(p) : p);
    if (!withinRemote(canonicalRoot, canonicalTarget)) throw new Error('符号链接指向项目范围之外，已拒绝访问');
    return { s, target: parent ? childRemote(canonicalTarget, path.posix.basename(p)) : canonicalTarget };
  }
  loadManifest(): Promise<Project[]> { return this.discoverProjects(); }
  async list(binding: RemoteBinding, target: string): Promise<RemoteEntry[]> {
    const { s, target: canonical } = await this.checked(binding, target);
    return new Promise((resolve, reject) => s.readdir(canonical, (e, list) => {
      if (e) return reject(friendlySftp(e));
      const entries = list.filter(x => x.filename !== '.' && x.filename !== '..').map(x => ({ name: x.filename, path: childRemote(target, x.filename), kind: x.attrs.isSymbolicLink() ? 'link' as const : x.attrs.isDirectory() ? 'directory' as const : 'file' as const, size: x.attrs.size, modified: x.attrs.mtime * 1000 }));
      resolve(entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'zh-CN')));
    }));
  }
  private async readLimited(s: SFTPWrapper, target: string, limit: number) {
    const chunks: Buffer[] = []; let count = 0;
    const stream = s.createReadStream(target, { start: 0, end: limit });
    try { for await (const chunk of stream) { const buffer = Buffer.from(chunk); chunks.push(buffer); count += buffer.length; } } catch (e) { throw friendlySftp(e); }
    return { buffer: Buffer.concat(chunks).subarray(0, limit), truncated: count > limit };
  }
  async preview(binding: RemoteBinding, target: string): Promise<FilePreview> {
    const checked = await this.checked(binding, target); const stats = await this.stat(checked.s, checked.target);
    if (!stats.isFile()) throw new Error('只能预览普通文件');
    const name = path.posix.basename(target), ext = path.posix.extname(name).toLowerCase();
    const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    if (mime[ext] && stats.size <= 5 * 1024 * 1024) { const data = await this.readLimited(checked.s, checked.target, 5 * 1024 * 1024); return { name, path: target, type: 'image', content: `data:${mime[ext]};base64,${data.buffer.toString('base64')}`, size: stats.size, truncated: false }; }
    const data = await this.readLimited(checked.s, checked.target, MAX_PREVIEW);
    if (data.buffer.includes(0) || ['.zip', '.pdf', '.docx', '.xlsx', '.exe'].includes(ext)) return { name, path: target, type: 'binary', content: '', truncated: false, size: stats.size };
    return { name, path: target, type: 'text', content: data.buffer.toString('utf8'), truncated: data.truncated, size: stats.size };
  }
  async download(binding: RemoteBinding, target: string, local: string, progress: (bytes: number, total: number) => void = () => {}) {
    const c = await this.checked(binding, target), stats = await this.stat(c.s, c.target);
    if (!stats.isFile()) throw new Error('只能下载普通文件');
    await fsp.mkdir(path.dirname(local), { recursive: true });
    const temp = local + '.' + randomUUID() + '.partial'; let count = 0;
    try {
      await pipeline(c.s.createReadStream(c.target), new Transform({ transform(chunk, _encoding, done) { count += chunk.length; progress(count, stats.size); done(null, chunk); } }), fs.createWriteStream(temp, { flags: 'wx' }));
      if (count !== stats.size) throw new Error('传输期间文件大小发生变化，请重新下载');
      await fsp.rename(temp, local);
    } catch (e) { await fsp.rm(temp, { force: true }); throw friendlySftp(e); }
  }
  async upload(binding: RemoteBinding, local: string, target: string, progress: (bytes: number, total: number) => void) {
    const c = await this.checked(binding, target, true); const size = (await fsp.stat(local)).size;
    const temporary = childRemote(path.posix.dirname(c.target), '.' + path.posix.basename(c.target) + '.' + randomUUID() + '.uploading');
    let count = 0;
    try {
      await pipeline(fs.createReadStream(local), new Transform({ transform(chunk, _encoding, done) { count += chunk.length; progress(count, size); done(null, chunk); } }), c.s.createWriteStream(temporary, { flags: 'wx', mode: binding.project.managed && withinRemote(path.posix.join(binding.project.remoteRoot, 'trajectories'), target) ? 0o600 : binding.project.managed && withinRemote(path.posix.join(binding.project.remoteRoot, 'submissions'), target) ? 0o640 : 0o660 }));
      // Revalidate identity and project binding at the commit boundary.
      this.channel(binding);
      await this.checked(binding, target, true);
      await new Promise<void>((resolve, reject) => c.s.rename(temporary, c.target, e => e ? reject(e) : resolve()));
    } catch (e) { c.s.unlink(temporary, () => {}); throw friendlySftp(e); }
  }
}
