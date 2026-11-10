import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AgentSession, ProjectConclusion, RemoteBinding, SourceFile } from '../shared/types';
import { type ResultReference, type SharedContent } from '../shared/content';
import type { ResultDirectory } from '../shared/result-directories';
import { currentResultSource, resultReferenceKey, resultVersionKey, sourceResultReference, supportsSessionResults, type AttachResultsResponse, type ResultLinkedAttachment, type SessionResultCandidate, type SessionResultCandidates } from '../shared/session-results';
import { conclusionTitle } from '../shared/conclusion-context';
import { sourceWasAccepted } from '../shared/session-context';
import { assertContentReadable } from '../shared/content-files-state';
import { teamAccessRevoked } from '../shared/team-cache';
import { readTeamCache, refreshTeamCache } from './team-cache';
import { atomicJson, type Store } from './store';
import type { SharedFiles } from './shared-files';
import { freezeFile, hashFile } from './artifacts';
import { safeFilename } from './paths';

interface Host {
  store: Store; remote: SharedFiles;
  session(id: string): AgentSession;
  fileSession(id: string): Promise<AgentSession>;
  personal(projectId: string, includeArchived?: boolean): ProjectConclusion[];
  directories(projectId: string): ResultDirectory[];
  binding(projectId: string): RemoteBinding;
  connected(projectId: string): boolean;
  teamTitle(projectId: string, item: SharedContent): string;
  edit<T>(id: string, run: () => Promise<T>): Promise<T>;
  record(reference: ResultReference, session: AgentSession, title: string): void;
  changed(): void;
}
type TeamState = { items: SharedContent[]; directories: ResultDirectory[]; available: boolean; cached: boolean; warning?: string };
const fileType = (name: string) => path.extname(name).slice(1).toUpperCase() || '文件';

/** Account-local references and an on-demand, read-only attachment gateway. */
export class SessionResults {
  private server?: http.Server;
  private starting?: Promise<string>;
  private base?: string;
  private secret = randomBytes(32);
  private closed = false;
  private downloads = new Map<string, Promise<string>>();
  private copies = new Map<string, Promise<string>>();
  private writes = new Map<string, Promise<unknown>>();
  private published = new Set<string>();
  private publishing = new Set<string>();
  constructor(private host: Host) {}
  private selectedSession(id: string) {
    const session = this.host.session(id);
    if (!supportsSessionResults(session)) throw Error(session.closedAt ? '请选择未关闭的工作会话' : session.codexRemote || session.cursorNative ? '此接入方式暂不支持本机成果引用，请使用支持文件引用的本机会话' : '请选择工作会话');
    if (!session.binding) throw Error('请选择项目');
    return session;
  }
  private async team(session: AgentSession, refresh: boolean): Promise<TeamState> {
    const projectId = session.binding!.project.id;
    const [list, dirs] = await Promise.all([
      readTeamCache<SharedContent[]>(this.host, { action: 'content.list', projectId }),
      readTeamCache<ResultDirectory[]>(this.host, { action: 'result.directory.list', projectId }),
    ]);
    let items = list?.value || [], directories = dirs?.value || [], warning: string | undefined;
    let available = !!list, cached = !!list;
    if (refresh && this.host.connected(projectId)) {
      const binding = this.host.binding(projectId);
      try { items = await refreshTeamCache(this.host, { action: 'content.list', projectId }, () => this.host.remote.contentList(binding)); available = true; cached = false; }
      catch (error: any) { if (teamAccessRevoked(error)) throw error; warning = error.message; }
      try { directories = await refreshTeamCache(this.host, { action: 'result.directory.list', projectId }, () => this.host.remote.resultDirectories(binding)); }
      catch (error: any) { if (teamAccessRevoked(error)) throw error; warning ||= error.message; }
    } else if (refresh) warning = available ? '中央节点未连接，当前显示本地缓存；未缓存的团队附件需联网取件。' : '本机尚无团队成果缓存，连接当前项目的中央节点后可读取。';
    return { items, directories, available, cached, warning };
  }
  async candidates(id: string, scope: 'personal' | 'team', refresh = false): Promise<SessionResultCandidates> {
    const session = this.selectedSession(id), projectId = session.binding!.project.id;
    let items: SessionResultCandidate[], directories: ResultDirectory[], available = true, cached = false, warning: string | undefined;
    if (scope === 'personal') {
      directories = this.host.directories(projectId);
      items = this.host.personal(projectId).map(item => ({ reference: { scope, projectId, id: item.id, version: item.version }, title: conclusionTitle(item), content: item.content, category: item.category, folderId: item.folderId, author: item.resultOwner || '个人成果', updatedAt: item.updatedAt, attachments: (item.localFiles || []).map(({ name, sha256, size }) => ({ name, sha256, size })) }));
    } else {
      const state = await this.team(session, refresh); ({ directories, available, cached, warning } = state);
      items = state.items.filter(item => item.kind === 'contribution' && !item.deletedAt && !item.supersededBy).map(item => {
        let unavailable: string | undefined; try { assertContentReadable(item); } catch (error: any) { unavailable = error.message; }
        return { reference: { scope, projectId, id: item.id, version: item.revision }, title: this.host.teamTitle(projectId, item), content: item.description, category: item.category, folderId: item.folderId, author: item.author, updatedAt: item.updatedAt, attachments: (item.attachments || []).map(({ name, sha256, size }) => ({ name, sha256, size })), unavailable };
      });
    }
    this.selectedSession(id); // Ignore late reads after an account/session switch.
    return { items: items.map(item => { const source = currentResultSource(session, item.reference); return { ...item, linkedVersion: source && sourceResultReference(session, source)?.version, needsLinkUpgrade: !!source && !source.resultLink }; }), directories, available, cached, warning };
  }
  async attach(id: string, references: ResultReference[]): Promise<AttachResultsResponse> {
    this.selectedSession(id);
    return this.host.edit('result-attach:' + id, async () => {
      const result: AttachResultsResponse = { added: [], failed: [] };
      let team: TeamState | undefined, teamError: unknown;
      if (references.some(ref => ref.scope === 'team')) try { team = await this.team(this.selectedSession(id), true); } catch (error) { teamError = error; }
      const seen = new Set<string>();
      for (const reference of references) {
        if (seen.has(resultVersionKey(reference))) continue; seen.add(resultVersionKey(reference));
        try { if (reference.scope === 'team' && teamError) throw teamError; result.added.push({ reference, source: await this.attachOne(id, reference, team) }); }
        catch (error: any) { result.failed.push({ reference, error: error.message || '关联失败' }); }
      }
      return result;
    });
  }
  async one(id: string, scope: 'personal' | 'team', resultId: string, version?: number) {
    this.selectedSession(id);
    return this.host.edit('result-attach:' + id, async () => {
      const session = this.selectedSession(id), projectId = session.binding!.project.id;
      // Legacy callers must not silently upgrade a reference. New entry points
      // pass the version the user actually selected, including explicit updates.
      if (version === undefined) {
        const existing = currentResultSource(session, { scope, projectId, id: resultId, version: 1 });
        if (existing) return existing;
      }
      const team = scope === 'team' ? await this.team(session, true) : undefined;
      this.selectedSession(id);
      version ??= scope === 'personal' ? this.host.personal(projectId, true).find(item => item.id === resultId)?.version : team?.items.find(item => item.id === resultId)?.revision;
      if (version === undefined) throw Error('成果已删除或不属于当前项目');
      return this.attachOne(id, { scope, projectId, id: resultId, version }, team);
    });
  }
  private async attachOne(id: string, reference: ResultReference, team?: TeamState) {
    const session = this.selectedSession(id), projectId = session.binding!.project.id;
    if (reference.projectId !== projectId) throw Error('成果与会话不属于同一项目');
    const existing = session.sources.find(source => source.resultLink && resultVersionKey(source.resultLink.reference) === resultVersionKey(reference) && !source.supersededBy && !source.resultUnavailable);
    let title: string, body: string, sourcePath: string, attachments: ResultLinkedAttachment[];
    if (reference.scope === 'personal') {
      const item = this.host.personal(projectId, true).find(item => item.id === reference.id);
      if (!item || item.deletedAt) throw Error('成果已删除或不属于当前项目');
      if (existing) return existing;
      if (item.archived) throw Error('成果已归档，请恢复后再关联');
      if (item.version !== reference.version) throw Error('成果版本已变化，请刷新并重新选择');
      title = conclusionTitle(item); sourcePath = `local-conclusion:${item.id}:v${item.version}`;
      body = `# ${item.title}\n\n本地结论版本：v${item.version}\n更新时间：${item.updatedAt}\n\n来源：\n${item.sources.map(source => `- ${source.title}${source.revision ? ' · v' + source.revision : ''}${source.path ? ' · ' + source.path : ''}`).join('\n') || '- 本机手工记录'}\n\n${item.content}`;
      attachments = (item.localFiles || []).map(file => ({ name: file.name, sha256: file.sha256, size: file.size, sourcePath: file.localPath }));
    } else {
      const item = (team || await this.team(session, true)).items.find(item => item.id === reference.id && !item.deletedAt);
      if (!item) throw Error('成果已删除或不属于当前项目');
      assertContentReadable(item);
      if (existing) return existing;
      if (item.revision !== reference.version) throw Error('成果版本已变化，请刷新并重新选择');
      title = this.host.teamTitle(projectId, item); sourcePath = item.path;
      body = `# ${title}\n\n远端原标题：${item.title}\n提交人：${item.author}；维护人：${item.updatedBy}；修订：${item.revision}；更新：${item.updatedAt}\n来源：${item.path}\n${item.repoUrl || ''}\n\n${item.description}`;
      attachments = (item.attachments || []).map(file => ({ name: file.name, sha256: file.sha256, size: file.size, sourcePath: file.path }));
    }
    this.selectedSession(id);
    const temporary = path.join(this.host.store.sessionDir(id), 'result-' + randomUUID() + '.md');
    await fs.mkdir(path.dirname(temporary), { recursive: true });
    if (attachments.length) body += '\n\n## 关联附件（按需读取）\n\n' + attachments.map(file => `- ${file.name} · ${fileType(file.name)} · ${file.size} 字节 · SHA256 ${file.sha256}`).join('\n') + '\n\n以上只提供附件清单，未预载内容。需要时读取本轮上下文中的成果附件索引，以本机终端访问取件链接，得到本地文件路径后再决定读取范围。';
    await fs.writeFile(temporary, body, { mode: 0o600 });
    let source: SourceFile;
    try { source = await freezeFile(temporary, path.join(this.host.store.sessionDir(id), 'sources')); }
    finally { await fs.unlink(temporary).catch(() => {}); }
    source.name = title + (reference.scope === 'personal' ? ' · 本地结论 v' : ' · v') + reference.version; source.sourcePath = sourcePath;
    source.resultLink = { reference: structuredClone(reference), attachments };
    if (reference.scope === 'team') source.contentRef = { projectId, id: reference.id, revision: reference.version };
    this.selectedSession(id);
    const prior = new Map(session.sources.map(value => [value.id, value.supersededBy]));
    for (const value of session.sources) { const ref = sourceResultReference(session, value); if (!value.supersededBy && ref && resultReferenceKey(ref) === resultReferenceKey(reference)) value.supersededBy = source.id; }
    session.sources.push(source);
    try { this.host.record(reference, session, title); await this.host.store.save(); }
    catch (error) { session.sources = session.sources.filter(value => value.id !== source.id); for (const value of session.sources) value.supersededBy = prior.get(value.id); throw error; }
    this.host.changed(); return source;
  }
  private token(sessionId: string) { return createHmac('sha256', this.secret).update(sessionId).digest('hex'); }
  private ensureGateway(): Promise<string> {
    if (this.closed) return Promise.reject(Error('工作台取件服务已关闭'));
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const server = this.server = http.createServer((request, response) => { void this.read(request, response); });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') return reject(Error('附件取件入口无法启动')); this.base = `http://127.0.0.1:${address.port}`; resolve(this.base); });
      server.unref();
    });
    const starting = this.starting;
    void starting.catch(() => { if (this.starting === starting) this.starting = undefined; });
    return this.starting;
  }
  /** Publishing happens at send time, never when a running turn's draft changes. */
  async prepareContext(session: AgentSession, includePending = true): Promise<string | undefined> {
    const sources = session.sources.filter(source => source.resultLink?.attachments.length && !source.resultUnavailable && (includePending ? !source.supersededBy || sourceWasAccepted(session, source) : sourceWasAccepted(session, source)));
    if (!sources.length) return;
    this.publishing.add(session.id);
    try {
      const base = await this.ensureGateway(), directory = this.host.store.sessionDir(session.id), file = path.join(directory, 'result-attachments.json');
      const job = (this.writes.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
        const results = [];
        for (const source of sources) {
          const link = source.resultLink!, indexPath = path.join(directory, 'result-indexes', source.id + '.json');
          const attachments = link.attachments.map(attachment => ({ name: attachment.name, type: fileType(attachment.name), size: attachment.size, sha256: attachment.sha256, result: source.name,
            url: `${base}/read/${this.token(session.id)}/${session.id}/${source.id}/${attachment.sha256}/${encodeURIComponent(attachment.name)}` }));
          const entry = { reference: link.reference, title: source.name, active: !source.supersededBy, attachments };
          await atomicJson(indexPath, entry); results.push({ reference: link.reference, title: source.name, active: !source.supersededBy, indexPath, attachmentCount: attachments.length });
        }
        await atomicJson(file, { version: 1, instruction: '附件未预载。active=false 是已发送的旧版引用，仅用于历史追溯；新轮次默认使用 active=true 的引用。仅在需要时读取各成果的 indexPath，并通过本机终端访问附件 url（127.0.0.1，绕过代理，不使用云端浏览器）。GET 返回校验后的本地文件路径 JSON；再自行选择读取范围。旧链接不可用时重新读取此固定索引文件。', results });
      });
      this.writes.set(file, job); try { await job; this.published.add(session.id); } finally { if (this.writes.get(file) === job) this.writes.delete(file); }
      return file;
    } finally { this.publishing.delete(session.id); }
  }
  async restore() {
    for (const session of this.host.store.sessions) {
      // Reconnection keeps this process's links valid. Do not replace a manifest
      // frozen for an in-flight send with only its previously accepted sources.
      if (this.published.has(session.id) || this.publishing.has(session.id)) continue;
      if (!session.sources.some(source => source.resultLink?.attachments.length && sourceWasAccepted(session, source))) continue;
      try { this.host.session(session.id); await this.prepareContext(session, false); } catch { /* Another account or a missing legacy file cannot prevent startup. */ }
    }
  }
  private async read(request: http.IncomingMessage, response: http.ServerResponse) {
    const reply = (status: number, value: unknown) => { if (response.destroyed || response.writableEnded) return; response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)); };
    try {
      if (this.closed || request.method !== 'GET' || request.headers.origin || request.headers.host !== new URL(this.base!).host) return reply(403, { error: '仅支持本机授权取件' });
      const match = request.url?.match(/^\/read\/([a-f0-9]{64})\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/([a-f0-9]{64})\/[^/?]+$/);
      if (!match || match[1] !== this.token(match[2])) return reply(403, { error: '取件链接已失效，请重新读取本轮成果附件索引' });
      const session = await this.host.fileSession(match[2]), source = session.sources.find(source => source.id === match[3]);
      if (!source?.resultLink || source.resultUnavailable || source.resultLink.reference.projectId !== session.binding?.project.id) return reply(403, { error: '附件未关联到此会话，或引用已不可用' });
      const attachment = source.resultLink.attachments.find(file => file.sha256 === match[4]);
      if (!attachment) return reply(403, { error: '附件不属于此成果引用' });
      const file = await this.materialize(session, source, attachment);
      const current = await this.host.fileSession(session.id);
      if (!current.sources.some(value => value.id === source.id && !value.resultUnavailable) || current.binding?.project.id !== source.resultLink.reference.projectId) throw Error('成果引用已撤销或项目已改变');
      this.host.binding(source.resultLink.reference.projectId);
      reply(200, { name: attachment.name, path: file, size: attachment.size, sha256: attachment.sha256, type: fileType(attachment.name) });
    } catch (error: any) { reply(409, { error: error.message || '附件无法读取' }); }
  }
  private async verified(file: string, attachment: ResultLinkedAttachment) {
    const stat = await fs.stat(file).catch(() => undefined);
    return !!stat?.isFile() && stat.size === attachment.size && await hashFile(file) === attachment.sha256;
  }
  private async materialize(session: AgentSession, source: SourceFile, attachment: ResultLinkedAttachment) {
    const ref = source.resultLink!.reference;
    this.host.binding(ref.projectId); // Recheck current project/account membership, including cache hits.
    if (ref.scope === 'personal' && !this.host.personal(ref.projectId, true).some(item => item.id === ref.id && !item.deletedAt)) throw Error('个人成果已删除或无权访问');
    if (ref.scope === 'team' && this.host.connected(ref.projectId)) {
      // Offline cache remains usable on transport failures, but an authoritative
      // permission rejection or deletion must also invalidate a cached retrieval.
      const state = await this.team(session, true);
      if (state.available && !state.items.some(item => item.id === ref.id && !item.deletedAt)) throw Error('团队成果已删除或无权访问');
    }
    const cache = path.join(this.host.store.root, 'result-attachment-cache', attachment.sha256);
    if (!await this.verified(cache, attachment)) {
      let job = this.downloads.get(attachment.sha256);
      if (!job) {
        job = (async () => {
          const temporary = cache + '.' + randomUUID() + '.tmp'; await fs.mkdir(path.dirname(cache), { recursive: true });
          try {
            if (ref.scope === 'personal') {
              try { await fs.copyFile(attachment.sourcePath, temporary); }
              catch (error: any) { throw Error(error.code === 'ENOENT' ? '此版本的个人附件已缺失，未使用其他版本替代' : '个人附件无法读取：' + error.message); }
            }
            else {
              if (!this.host.connected(ref.projectId)) throw Error('团队附件尚未缓存，请连接当前项目的中央节点后按需重试');
              const prefix = session.binding!.project.remoteRoot.replace(/\/$/, '') + '/.workbench-attachments/';
              if (!attachment.sourcePath.startsWith(prefix) || !attachment.sourcePath.endsWith('/' + attachment.sha256) || attachment.sourcePath.slice(prefix.length).split('/').some(part => !part || part === '..' || part === '.')) throw Error('团队附件来源路径无效');
              await this.host.remote.download(this.host.binding(ref.projectId), attachment.sourcePath, temporary, undefined, { sha256: attachment.sha256, size: attachment.size });
            }
            if (!await this.verified(temporary, attachment)) throw Error('附件内容或版本不符，未使用其他版本替代');
            if (this.closed) throw Error('工作台取件服务已关闭');
            await fs.rename(temporary, cache); return cache;
          } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
        })();
        this.downloads.set(attachment.sha256, job); void job.finally(() => { if (this.downloads.get(attachment.sha256) === job) this.downloads.delete(attachment.sha256); }).catch(() => {});
      }
      await job;
    }
    const latest = await this.host.fileSession(session.id);
    if (!latest.sources.some(value => value.id === source.id && !value.resultUnavailable)) throw Error('成果引用已撤销或不可用');
    const target = path.join(this.host.store.sessionDir(session.id), 'result-files', attachment.sha256 + '-' + safeFilename(attachment.name));
    if (await this.verified(target, attachment)) return target;
    let copy = this.copies.get(target);
    if (!copy) {
      copy = (async () => {
        const temporary = target + '.' + randomUUID() + '.tmp';
        await fs.mkdir(path.dirname(target), { recursive: true });
        try {
          await fs.copyFile(cache, temporary);
          if (!await this.verified(temporary, attachment)) throw Error('附件缓存校验失败，请重新取件');
          await fs.rename(temporary, target); return target;
        } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      })();
      this.copies.set(target, copy); void copy.finally(() => { if (this.copies.get(target) === copy) this.copies.delete(target); }).catch(() => {});
    }
    return copy;
  }
  async close() {
    this.closed = true;
    await this.starting?.catch(() => {});
    await Promise.allSettled(this.writes.values());
    const server = this.server;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}
