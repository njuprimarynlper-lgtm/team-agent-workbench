import { storageRequest } from './storage-requests';
import { hashFile } from './artifacts';
import type { ContentEdit, ContentMetadata, SharedContent } from '../shared/content';
import { Client, type SFTPWrapper, type Stats } from 'ssh2';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline, finished } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import type { ConnectionProfile, FilePreview, Project, RemoteBinding, RemoteEntry, WorkspaceAccess } from '../shared/types';
import { assertRemote, childRemote, remotePath, withinRemote } from './paths';
import { systemUsername } from './account-login';
import { newProjectLayout, projectName } from './project-layout';
import { PROJECT_BRIEF_FILE, projectBriefSchema, projectBriefMarkdown, type ProjectBrief } from '../shared/project-brief';
import { groupWorkspacePattern } from '../shared/groups';
const MAX_PREVIEW = 512 * 1024;
export function sameEndpoint(a: RemoteBinding, b: ConnectionProfile): boolean {
  return a.connectionId === b.id && a.host === b.host && a.port === b.port && a.username === b.username && a.fingerprint === b.fingerprint;
}
export function friendlySftp(error: any): Error {
  if (error.code === 3) return new Error('Linux 拒绝访问：当前账号没有此目录或文件的权限');
  if ((error as any).code === 2) return new Error('远端路径不存在，请核对管理员提供的 SFTP 路径');
  return new Error(error.message || String(error));
}
export class SftpConnection {
  private storageVersion = 0;
  offlineHours = 8;
  private client?: Client; private sftp?: SFTPWrapper;
  profile?: ConnectionProfile;
  workspace?: WorkspaceAccess; workspaces: WorkspaceAccess[] = [];
  constructor(private changed: () => void = () => {}) {}
  get connected() { return !!this.sftp; }
  async connect(profile: ConnectionProfile, password: string, trust: (fingerprint: string) => Promise<boolean>) {
    this.disconnect(); this.storageVersion = 0;
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
      this.storageVersion = roles.storageVersion || 0;
      this.offlineHours = Number.isInteger(roles.offlineHours) ? Math.max(1, Math.min(24, roles.offlineHours)) : 8;
      if (roles.version !== 1 || roles.membershipVersion !== 1) throw new Error('请管理员使用新版管理员端刷新成员信息');
      const user = Object.hasOwn(roles.users || {}, username) ? roles.users[username] : undefined;
      if (!user) throw new Error('当前账号未启用或不属于此团队，请联系管理员');
      if (!Array.isArray(user.groups) || user.groups.length > 200) throw new Error('工作组记录格式无效');
      const seen = new Set<string>(), roots = new Set<string>();
      return user.groups.map((g: any) => {
        if (typeof g.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(g.id) || typeof g.name !== 'string' || !g.name || g.name.length > 160 || seen.has(g.id)) throw new Error('工作组记录格式无效');
        const workspace = g.workspace || '';
        // An unrecognised path may simply be newer than this client; keep the reason visible instead of calling the record corrupt.
        if (typeof workspace !== 'string' || (workspace && (!groupWorkspacePattern.test(workspace) || roots.has(workspace)))) throw new Error('用户组的共享目录路径无法识别，请先升级用户版；若仍失败，请联系管理员核对成员信息');
        seen.add(g.id); if (workspace) roots.add(workspace);
        return { groupName: g.id, groupLabel: g.name, path: workspace, canonicalPath: workspace, canCreateProject: !!workspace && Array.isArray(user.contentGroups) && user.contentGroups.some((a: any) => a.id === g.id && a.workspace === workspace), ...(!workspace ? { accessError: '管理员尚未完成工作组目录配置' } : {}) };
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
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) return undefined;
      const data = await this.readLimited(s, marker, 256 * 1024); if (data.truncated) return undefined;
      const meta = JSON.parse(data.buffer.toString('utf8'));
      if (meta.version !== 1 || !/^project_[a-f0-9]{32}$/.test(meta.id)) return undefined;
      return this.projectForUser({ id: meta.id, name: projectName(meta.name), briefRevision: meta.briefRevision || 0, remoteRoot: root, uploadPath: root, historyPath: childRemote(root, 'trajectories'), groupName: workspace?.groupName, groupLabel: workspace?.groupLabel });
    } catch (error: any) { if (error instanceof SyntaxError || (error as any).code === 2 || /不存在|拒绝访问|项目名/.test(error.message)) return undefined; throw error; }
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
        workspace.isEmpty = false;
        const directories = entries.filter(e => !e.filename.startsWith('.') && (e.attrs.mode & 0o170000) === 0o040000);
        if (directories.length > 500) throw new Error('工作组目录超过 500 项，请联系管理员整理');
        const found: Project[] = [];
        for (const entry of directories) { const project = await this.readProject(childRemote(workspace.path, entry.filename), workspace); if (project) found.push(project); }
        workspace.isEmpty = found.length === 0;
        projects.push(...found);
      } catch (e: any) { workspace.accessError = e.message; workspace.canCreateProject = false; }
    }
    if (this.channel() !== s || this.profile !== profile) throw new Error('刷新期间连接已改变');
    this.workspaces = workspaces; this.workspace = workspaces[0]; profile.projects = projects; profile.workPath = ''; profile.manifestPath = '';
    this.changed(); return projects;
  }
  private requireStorage() { if (this.storageVersion !== 1) throw new Error('服务器尚未启用受控文件操作。请管理员使用新版管理员端配置 SFTP 与文件操作器；当前只允许读取。'); }
  private request(data: Record<string, unknown>, binding?: RemoteBinding, local?: string, progress?: (bytes: number, total: number) => void) {
    this.requireStorage(); const s = this.channel(binding), profile = this.profile!;
    return storageRequest(s, profile.username, data, () => { if (this.channel(binding) !== s || this.profile !== profile) throw new Error('请求期间连接已改变'); }, local, progress);
  }
  async createProject(name: string, groupName?: string, brief?: ProjectBrief): Promise<Project> {
    await this.loadManifest();
    const workspace = groupName ? this.workspaces.find(w => w.groupName === groupName) : this.workspaces.length === 1 ? this.workspaces[0] : undefined;
    if (!workspace?.canCreateProject || workspace.accessError) throw new Error('请选择可管理的工作组；只有本组子管理员可以创建项目');
    const result = await this.request({ op: 'create_project', name: projectName(name), groupName: workspace.groupName, brief });
    await this.loadManifest(); const project = this.profile!.projects.find(p => p.id === result.projectId); if (!project) throw new Error('项目已创建，请刷新工作组查看'); return project;
  }
  async ensurePersonalFolder(binding: RemoteBinding, _target: string) { this.channel(binding); this.requireStorage(); }
  async contentList(binding: RemoteBinding): Promise<SharedContent[]> {
    const s = this.channel(binding); await this.checked(binding, binding.project.remoteRoot);
    return new Promise((resolve, reject) => s.readFile(childRemote(binding.project.remoteRoot, '.workbench-content.json'), (error, buffer) => { if (error) { if ((error as any).code === 2) resolve([]); else reject(friendlySftp(error)); return; } try { const items = JSON.parse(buffer.toString('utf8')); if (!Array.isArray(items)) throw new Error('公共内容索引无效'); resolve(items); } catch (e) { reject(e); } }));
  }
  contentEdit(binding: RemoteBinding, change: ContentEdit) { return this.request({ op: 'edit_content', projectId: binding.project.id, change }, binding) as Promise<SharedContent | undefined>; }
  contentAdopt(binding: RemoteBinding, target: string) { return this.request({ op: 'adopt_content', projectId: binding.project.id, target }, binding); }
  async contentReplace(binding: RemoteBinding, change: ContentEdit, file: string) { return this.request({ op: 'edit_content', projectId: binding.project.id, change, replacement: { extension: path.extname(file), sha256: await hashFile(file) } }, binding, file); }
  async projectBrief(binding: RemoteBinding) { const s = this.channel(binding); const data = await this.readLimited(s, childRemote(binding.project.remoteRoot, '.workbench-project.json'), 256 * 1024); const meta = JSON.parse(data.buffer.toString('utf8')); return { brief: meta.brief, revision: meta.briefRevision || 0, updatedAt: meta.briefUpdatedAt || meta.createdAt }; }
  saveProjectBrief(binding: RemoteBinding, brief: ProjectBrief, revision: number) { return this.request({ op: 'save_brief', projectId: binding.project.id, brief: projectBriefSchema.parse(brief), revision }, binding); }
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
    // Await the remote CLOSE acknowledgement too. Disconnecting after EOF but
    // before CLOSE used to emit an unhandled stream error during account changes.
    const closed = finished(stream); void closed.catch(() => {});
    try { for await (const chunk of stream) { const buffer = Buffer.from(chunk); chunks.push(buffer); count += buffer.length; } await closed; } catch (e) { throw friendlySftp(e); }
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
  async upload(binding: RemoteBinding, local: string, target: string, progress: (bytes: number, total: number) => void, metadata?: ContentMetadata, hash?: string) {
    assertRemote(binding.project.remoteRoot, target);
    return this.request({ op: 'publish', projectId: binding.project.id, target, sha256: hash || await hashFile(local), metadata }, binding, local, progress);
  }
}
