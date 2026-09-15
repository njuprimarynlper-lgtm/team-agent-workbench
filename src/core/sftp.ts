import { Client, type SFTPWrapper, type Stats } from 'ssh2';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import type { ConnectionProfile, FilePreview, Project, RemoteBinding, RemoteEntry } from '../shared/types';
import { assertRemote, childRemote, remotePath, withinRemote } from './paths';
import { manifestSchema } from './config';
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
  constructor(private changed: () => void = () => {}) {}
  get connected() { return !!this.sftp; }
  async connect(profile: ConnectionProfile, password: string, trust: (fingerprint: string) => Promise<boolean>) {
    this.disconnect();
    const client = new Client(); this.client = client;
    let fingerprint = '';
    await new Promise<void>((resolve, reject) => {
      client.on('error', reject);
      client.on('close', () => { if (this.client === client) { this.sftp = undefined; this.changed(); } });
      client.on('ready', () => client.sftp((error, channel) => {
        if (error) { reject(error); return; }
        this.sftp = channel; this.profile = { ...profile, fingerprint }; resolve(); this.changed();
      }));
      client.connect({ host: profile.host, port: profile.port, username: profile.username, password, readyTimeout: 30000, keepaliveInterval: 15000,
        hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
          fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          if (profile.fingerprint) { callback(profile.fingerprint === fingerprint); return; }
          trust(fingerprint).then(callback, () => callback(false));
        }
      });
    }).catch(e => { client.end(); throw friendlySftp(e); });
    return this.profile!;
  }
  disconnect() { this.sftp = undefined; this.client?.end(); this.client = undefined; this.changed(); }
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
  private real(s: SFTPWrapper, target: string): Promise<string> { return new Promise((resolve, reject) => s.realpath(target, (e, result) => e ? reject(friendlySftp(e)) : resolve(result))); }
  private stat(s: SFTPWrapper, target: string): Promise<Stats> { return new Promise((resolve, reject) => s.lstat(target, (e, result) => e ? reject(friendlySftp(e)) : resolve(result))); }
  async checked(binding: RemoteBinding, target: string, parent = false) {
    const s = this.channel(binding); const p = assertRemote(binding.project.remoteRoot, target);
    const canonicalRoot = await this.real(s, binding.project.remoteRoot);
    const canonicalTarget = await this.real(s, parent ? path.posix.dirname(p) : p);
    if (!withinRemote(canonicalRoot, canonicalTarget)) throw new Error('符号链接指向项目范围之外，已拒绝访问');
    return { s, target: parent ? childRemote(canonicalTarget, path.posix.basename(p)) : canonicalTarget };
  }
  async loadManifest(): Promise<Project[]> {
    const s = this.channel(); if (!this.profile!.manifestPath) return this.profile!.projects;
    const data = await this.readLimited(s, remotePath(this.profile!.manifestPath), 256 * 1024);
    if (data.truncated) throw new Error('项目入口清单过大');
    const projects = manifestSchema.parse(JSON.parse(data.buffer.toString('utf8'))).projects;
    this.profile!.projects = projects; return projects;
  }
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
      await pipeline(fs.createReadStream(local), new Transform({ transform(chunk, _encoding, done) { count += chunk.length; progress(count, size); done(null, chunk); } }), c.s.createWriteStream(temporary, { flags: 'wx', mode: 0o660 }));
      // Revalidate identity and project binding at the commit boundary.
      this.channel(binding);
      await this.checked(binding, target, true);
      await new Promise<void>((resolve, reject) => c.s.rename(temporary, c.target, e => e ? reject(e) : resolve()));
    } catch (e) { c.s.unlink(temporary, () => {}); throw friendlySftp(e); }
  }
}
