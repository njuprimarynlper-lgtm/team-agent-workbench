import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { z } from 'zod';
import type { AgentSession, ProjectConclusion, RemoteBinding } from '../shared/types';
import type { LocalResultApiConfig } from '../shared/local-result-api';
import { LocalResultPreconditionError, localResultEtag, localResultOpenApi, resultArchiveSchema, resultCreateSchema, resultMoveSchema, resultUpdateSchema, resultUploadNameSchema } from '../shared/local-result-api';
import { localResultApiMarker, localResultApiNotice } from '../shared/local-result-context';
import { resultDirectoryCommandSchema, resultDirectoryNodes, resultDirectoryLabel, resultItemFolder, type ResultDirectory, type ResultDirectoryCommand, type ResultDirectoryMove } from '../shared/result-directories';
import type { ContributionCategory } from '../shared/content';
import type { ResultStatus } from '../shared/result-model';
import { accountIdentity } from '../shared/account-data';
import { runtimeAssets } from '../shared/runtime-assets';
import { atomicJson, type Store } from './store';
import { hashFile } from './artifacts';

interface Host {
  store: Store; epoch(): number; binding(projectId: string): RemoteBinding;
  operate<T>(run: () => Promise<T>): Promise<T>;
  list(projectId: string, archived: boolean): ProjectConclusion[];
  directories(projectId: string): ResultDirectory[];
  create(projectId: string, title: string, content: string, category: ContributionCategory, status: ResultStatus | undefined, owner: string | undefined, folderId: string | undefined, id: string): Promise<ProjectConclusion>;
  update(id: string, title: string, content: string, category: ContributionCategory | undefined, status: ResultStatus | undefined, version: number, owner: string | undefined, etag: string): Promise<ProjectConclusion>;
  archive(id: string, archived: boolean, etag: string): Promise<ProjectConclusion>;
  remove(id: string, version: number, etag: string): Promise<unknown>;
  move(projectId: string, change: ResultDirectoryMove, etag: string): Promise<ProjectConclusion[]>;
  directory(projectId: string, change: ResultDirectoryCommand): Promise<unknown>;
  addFile(id: string, file: string, etag: string): Promise<ProjectConclusion>;
  removeFile(id: string, fileId: string, etag: string): Promise<ProjectConclusion>;
}
type Scope = { projectId: string; owner: string; epoch: number };
type Reply = { status: number; body: unknown; etag?: string; replayed?: boolean };
type Receipt = { fingerprint: string; targetId: string; state: 'pending' | 'done' | 'failed'; reply?: Reply };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const limit = 2 * 1024 * 1024;
export class LocalResultApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const fail = (status: number, code: string, message: string): never => { throw new LocalResultApiError(status, code, message); };
function failure(error: unknown): Reply {
  if (error instanceof LocalResultPreconditionError) return { status: 412, body: { error: { code: 'precondition_failed', message: error.message } } };
  if (error instanceof LocalResultApiError) return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  if (error instanceof z.ZodError) return { status: 400, body: { error: { code: 'invalid_request', message: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') } } };
  const message = error instanceof Error ? error.message : '操作失败';
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code)) return { status: 500, body: { error: { code: 'storage_error', message } } };
  const conflict = /已更新|不存在|已删除|已替代|被新成果替代|正在|请等待|重名|已有/.test(message);
  return { status: conflict ? 409 : 400, body: { error: { code: conflict ? 'conflict' : 'operation_failed', message } } };
}

/** Loopback REST API. Each capability is bound to one local account and project. */
export class LocalResultApi {
  private server?: http.Server;
  private starting?: Promise<string>;
  private base?: string;
  private closed = false;
  private secret = randomBytes(32);
  private grants = new Map<string, Scope>();
  private mutations: Promise<unknown> = Promise.resolve();
  private assets?: Promise<{ skillPath: string; clientPath: string }>;
  private requests = new Set<Promise<void>>();
  private temporary = new Set<string>();
  constructor(private host: Host) {}

  private async ensureGateway() {
    if (this.closed) throw Error('个人成果接口已关闭');
    if (this.starting) return this.starting;
    const server = this.server = http.createServer((request, response) => {
      const job = this.handle(request, response).finally(() => this.requests.delete(job)); this.requests.add(job);
    });
    server.requestTimeout = 5 * 60 * 1000; server.headersTimeout = 15000;
    this.starting = new Promise<string>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return reject(Error('个人成果接口无法启动'));
        this.base = `http://127.0.0.1:${address.port}`; resolve(this.base);
      }); server.unref();
    });
    try { return await this.starting; } catch (error) { this.starting = undefined; server.close(); throw error; }
  }

  private async skillAssets() {
    if (!this.assets) this.assets = (async () => {
      const read = async (asset: string, source: string) => {
        try { return await fs.readFile(path.join(__dirname, runtimeAssets, asset)); }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; return fs.readFile(path.join(__dirname, '../../skills/workbench-results', source)); }
      };
      const [skill, client] = await Promise.all([read('workbench-results-skill.md', 'SKILL.md'), read('workbench-results-client.mjs', 'scripts/client.mjs')]);
      const revision = createHash('sha256').update(skill).update(client).digest('hex').slice(0, 20);
      const root = path.join(this.host.store.root, 'local-result-api', 'skills', revision, 'workbench-results');
      const skillPath = path.join(root, 'SKILL.md'), clientPath = path.join(root, 'scripts', 'client.mjs');
      await fs.mkdir(path.dirname(clientPath), { recursive: true, mode: 0o700 });
      for (const [file, bytes] of [[skillPath, skill], [clientPath, client]] as const) {
        try { await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
        catch (error: any) { if (error.code !== 'EEXIST' || !(await fs.readFile(file)).equals(bytes)) throw error; }
      }
      return { skillPath, clientPath };
    })();
    try { return await this.assets; } catch (error) { this.assets = undefined; throw error; }
  }

  async prepare(session: AgentSession) {
    if (session.purpose !== 'work' || session.closedAt || session.codexRemote || session.cursorNative || !session.binding) return;
    const binding = this.host.binding(session.binding.project.id), owner = accountIdentity(binding), epoch = this.host.epoch();
    if (owner !== accountIdentity(session.binding)) throw Error('会话不属于当前账号');
    const [base, assets] = await Promise.all([this.ensureGateway(), this.skillAssets()]);
    if (this.closed) throw Error('个人成果接口已关闭');
    if (epoch !== this.host.epoch() || owner !== accountIdentity(this.host.binding(binding.project.id))) throw Error('账号已改变');
    const token = createHmac('sha256', this.secret).update(JSON.stringify([owner, epoch, binding.project.id])).digest('hex');
    this.grants.set(token, { projectId: binding.project.id, owner, epoch });
    const config: LocalResultApiConfig = { version: 1, baseUrl: `${base}/api/v1/projects/${encodeURIComponent(binding.project.id)}`, token, projectId: binding.project.id, projectName: binding.project.name, ...assets };
    const persistent = this.host.store.sessions.some(item => item.id === session.id);
    const directory = persistent ? this.host.store.sessionDir(session.id) : this.temporaryDirectory(session.id);
    if (!persistent) this.temporary.add(session.id);
    const configPath = path.join(directory, 'results-api.json');
    await atomicJson(configPath, config); await fs.chmod(configPath, 0o600);
    return { configPath, ...assets };
  }

  private temporaryDirectory(id: string) {
    z.string().uuid().parse(id);
    const root = path.resolve(this.host.store.root, 'local-result-api', 'temporary'), directory = path.resolve(root, id);
    if (path.dirname(directory) !== root) throw Error('临时配置路径无效');
    return directory;
  }
  async forgetTemporary(id: string) {
    await fs.rm(this.temporaryDirectory(id), { recursive: true, force: true }); this.temporary.delete(id);
  }

  async context(session: AgentSession) {
    const config = await this.prepare(session); if (!config) return '';
    if (session.messages.some(message => message.context?.accepted && message.context.nativeId === session.nativeId && message.text.includes(localResultApiMarker) && message.text.includes(JSON.stringify(config.configPath)))) return '';
    return localResultApiNotice(config);
  }

  async restore() {
    for (const session of this.host.store.sessions) {
      if (this.closed) break;
      try { await this.prepare(session); } catch { /* Other accounts and unavailable sessions keep their own descriptors. */ }
    }
  }

  private authenticate(request: http.IncomingMessage, projectId: string): Scope {
    if (this.closed || !this.base || request.headers.origin !== undefined || request.headers.host !== new URL(this.base).host) fail(403, 'local_only', '仅允许无 Origin 的本机客户端访问');
    const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '');
    if (!match) fail(401, 'unauthorized', '缺少或无效的 Bearer Token');
    const token = match![1], scope = this.grants.get(token);
    if (!scope || scope.projectId !== projectId || scope.epoch !== this.host.epoch()) fail(403, 'scope_expired', '接口授权已失效或不属于当前项目，请重新读取当前会话配置');
    const expected = createHmac('sha256', this.secret).update(JSON.stringify([scope!.owner, scope!.epoch, projectId])).digest('hex');
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(token))) fail(401, 'unauthorized', '接口授权无效');
    let current: RemoteBinding;
    try { current = this.host.binding(projectId); } catch { return fail(403, 'scope_expired', '当前账号无法访问此项目'); }
    if (accountIdentity(current) !== scope!.owner) fail(403, 'scope_expired', '账号已改变，请重新读取当前会话配置');
    return scope!;
  }

  private result(projectId: string, id: string) {
    z.string().uuid().parse(id);
    return this.host.list(projectId, true).find(item => item.id === id) || fail(404, 'not_found', '当前项目中没有这条个人成果');
  }
  private conditional(request: http.IncomingMessage, item: ProjectConclusion) {
    const expected = request.headers['if-match'];
    if (typeof expected !== 'string' || !/^"[a-f0-9]{64}"$/.test(expected)) fail(428, 'precondition_required', '修改已有成果需要读取时返回的完整 If-Match / ETag');
    if (localResultEtag(item) !== expected) fail(412, 'precondition_failed', '成果或附件已更新，请重新读取并合并后再修改');
    return expected! as string;
  }
  private publicResult(item: ProjectConclusion, full: boolean) {
    const directories = this.host.directories(item.projectId);
    return { id: item.id, projectId: item.projectId, title: item.title, category: item.category, resultStatus: item.resultStatus, resultOwner: item.resultOwner,
      version: item.version, etag: localResultEtag(item), updatedAt: item.updatedAt, archived: !!item.archived, supersededBy: item.supersededBy,
      folderId: resultItemFolder(item, directories), folderVersion: item.folderVersion || 0, folderPath: resultDirectoryLabel(resultItemFolder(item, directories), directories),
      ...(full ? { content: item.content, sources: item.sources, derivedFrom: item.derivedFrom, historyCount: item.versions?.length || 0 } : {}),
      attachments: (item.localFiles || []).map(({ id, name, sha256, size }) => ({ id, name, sha256, size })) };
  }
  private receipt(item: ProjectConclusion) {
    return { id: item.id, version: item.version, etag: localResultEtag(item), folderVersion: item.folderVersion || 0, attachments: (item.localFiles || []).map(({ id, name, sha256, size }) => ({ id, name, sha256, size })) };
  }
  private async json(request: http.IncomingMessage) {
    if (!(request.headers['content-type'] || '').startsWith('application/json')) fail(415, 'unsupported_media_type', '请求正文必须为 application/json');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > limit + 4096) fail(413, 'payload_too_large', 'JSON 请求超过 2 MiB 限制'); chunks.push(Buffer.from(chunk)); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(400, 'invalid_json', '请求正文不是有效 JSON'); }
  }
  private async upload(request: http.IncomingMessage) {
    if (request.headers['content-type'] !== 'application/octet-stream') fail(415, 'unsupported_media_type', '附件正文必须为 application/octet-stream');
    const maximum = 2 * 1024 ** 3, declared = Number(request.headers['content-length']);
    if (declared > maximum) fail(413, 'payload_too_large', '单个附件最大 2 GiB');
    const directory = path.join(this.host.store.root, 'local-result-api', 'uploads'); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, randomUUID()), hash = createHash('sha256'); let size = 0;
    try {
      await pipeline(request, new Transform({ transform(chunk, _encoding, done) { size += chunk.length; if (size > maximum) return done(new LocalResultApiError(413, 'payload_too_large', '单个附件最大 2 GiB')); hash.update(chunk); done(null, chunk); } }), createWriteStream(file, { flags: 'wx', mode: 0o600 }));
      return { file, hash: hash.digest('hex') };
    } catch (error) { await fs.rm(file, { force: true }); throw error; }
  }

  private async mutate(scope: Scope, request: http.IncomingMessage, url: URL, body: unknown, execute: (targetId: string) => Promise<Reply>): Promise<Reply> {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return fail(400, 'idempotency_key_required', '写入需要 8～128 位 Idempotency-Key；重试同一操作时复用原值');
    const fingerprint = digest(JSON.stringify([request.method, url.pathname, url.search, request.headers['if-match'], body]));
    const file = path.join(this.host.store.root, 'local-result-api', 'requests', digest(scope.owner), digest(scope.projectId), digest(key) + '.json');
    const job = this.mutations.catch(() => {}).then(async () => {
      let prior: Receipt | undefined;
      try { prior = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      if (prior) {
        if (prior.fingerprint !== fingerprint) return fail(409, 'idempotency_conflict', '同一幂等键不能用于不同的请求内容');
        if (prior.state === 'pending') return { status: 409, body: { error: { code: 'operation_interrupted', message: '上次操作可能已经执行，未自动重放。请先查询成果核对，再决定是否用新请求键执行。', resultId: prior.targetId } } };
        return { ...prior.reply!, replayed: true };
      }
      const existingId = /\/results\/([^/]+)/.exec(url.pathname)?.[1];
      const targetId = existingId ? decodeURIComponent(existingId) : url.pathname.endsWith('/directories') && body && typeof body === 'object' && 'id' in body ? String(body.id) : randomUUID();
      const pending: Receipt = { fingerprint, targetId, state: 'pending' };
      await atomicJson(file, pending);
      let reply: Reply;
      try { reply = await execute(pending.targetId); }
      catch (error) { reply = failure(error); await atomicJson(file, { ...pending, state: 'failed', reply }); return reply; }
      // A crash after the actual write leaves a pending receipt. Never blindly
      // re-run a possibly committed operation after a process restart.
      await atomicJson(file, { ...pending, state: 'done', reply }); return reply;
    });
    this.mutations = job; return job;
  }

  private async route(scope: Scope, request: http.IncomingMessage, response: http.ServerResponse, url: URL, parts: string[]): Promise<Reply | undefined> {
    const projectId = scope.projectId, method = request.method;
    if (parts.length === 1 && method === 'GET') {
      if (parts[0] === 'context') return { status: 200, body: { apiVersion: 1, projectId, projectName: this.host.binding(projectId).project.name, scope: 'personal', onlineRequired: false } };
      if (parts[0] === 'openapi.json') return { status: 200, body: localResultOpenApi() };
      if (parts[0] === 'directories') return { status: 200, body: { items: resultDirectoryNodes(this.host.directories(projectId)) } };
      if (parts[0] === 'results') {
        const query = z.object({ q: z.string().max(1000).default(''), includeArchived: z.enum(['true', 'false']).default('false'), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(30) }).strict().parse(Object.fromEntries(url.searchParams));
        const needle = query.q.toLocaleLowerCase(), items = this.host.list(projectId, query.includeArchived === 'true').filter(item => !needle || `${item.title}\n${item.content}`.toLocaleLowerCase().includes(needle));
        return { status: 200, body: { items: items.slice(query.offset, query.offset + query.limit).map(item => this.publicResult(item, false)), total: items.length, offset: query.offset, limit: query.limit } };
      }
    }
    if (parts.length === 1 && parts[0] === 'directories' && method === 'POST') {
      const change = resultDirectoryCommandSchema.parse(await this.json(request));
      return this.mutate(scope, request, url, change, async () => { await this.host.directory(projectId, change); return { status: 200, body: { items: resultDirectoryNodes(this.host.directories(projectId)) } }; });
    }
    if (parts.length === 1 && parts[0] === 'results' && method === 'POST') {
      const data = resultCreateSchema.parse(await this.json(request));
      return this.mutate(scope, request, url, data, async id => {
        const item = await this.host.create(projectId, data.title, data.content, data.category, data.resultStatus, data.resultOwner, data.folderId, id);
        return { status: 200, body: this.receipt(item), etag: localResultEtag(item) };
      });
    }
    if (parts[0] !== 'results' || !parts[1]) return fail(404, 'not_found', '接口不存在');
    const id = parts[1];
    if (parts.length === 2 && method === 'GET') { const item = this.result(projectId, id); return { status: 200, body: this.publicResult(item, true), etag: localResultEtag(item) }; }
    if (parts.length === 4 && parts[2] === 'attachments' && method === 'GET') {
      const item = this.result(projectId, id), attachment = item.localFiles?.find(file => file.id === parts[3]);
      if (!attachment) return fail(404, 'not_found', '附件不存在');
      try { if (await hashFile(attachment.localPath) !== attachment.sha256) return fail(409, 'attachment_changed', '附件快照已改变，未返回其他版本'); }
      catch (error) { if (error instanceof LocalResultApiError) throw error; return fail(404, 'attachment_missing', '附件文件缺失或无法读取'); }
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': attachment.size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      await pipeline(createReadStream(attachment.localPath), response); return;
    }
    if (parts.length === 3 && parts[2] === 'attachments' && method === 'POST') {
      this.result(projectId, id);
      const name = resultUploadNameSchema.parse(url.searchParams.get('name')), upload = await this.upload(request);
      try {
        return await this.mutate(scope, request, url, { name, sha256: upload.hash }, async () => {
          const current = this.result(projectId, id), expected = this.conditional(request, current);
          const named = path.join(path.dirname(upload.file), randomUUID()); await fs.mkdir(named, { mode: 0o700 });
          const source = path.join(named, name);
          try { await fs.rename(upload.file, source); const item = await this.host.addFile(id, source, expected); return { status: 200, body: this.receipt(item), etag: localResultEtag(item) }; }
          finally { await fs.rm(named, { recursive: true, force: true }); }
        });
      } finally { await fs.rm(upload.file, { force: true }); }
    }
    if (parts.length === 2 && method === 'PATCH') {
      const data = resultUpdateSchema.parse(await this.json(request));
      return this.mutate(scope, request, url, data, async () => {
        const item = this.result(projectId, id), expected = this.conditional(request, item);
        const saved = await this.host.update(id, data.title ?? item.title, data.content ?? item.content, data.category, data.resultStatus, item.version, data.resultOwner, expected);
        return { status: 200, body: this.receipt(saved), etag: localResultEtag(saved) };
      });
    }
    if (parts.length === 2 && method === 'DELETE') return this.mutate(scope, request, url, null, async () => { const item = this.result(projectId, id), expected = this.conditional(request, item); await this.host.remove(id, item.version, expected); return { status: 200, body: { id, deleted: true, teamDeleted: false } }; });
    if (parts.length === 3 && parts[2] === 'archive' && method === 'POST') {
      const data = resultArchiveSchema.parse(await this.json(request));
      return this.mutate(scope, request, url, data, async () => { const current = this.result(projectId, id), expected = this.conditional(request, current); const item = await this.host.archive(id, data.archived, expected); return { status: 200, body: this.receipt(item), etag: localResultEtag(item) }; });
    }
    if (parts.length === 3 && parts[2] === 'move' && method === 'POST') {
      const data = resultMoveSchema.parse(await this.json(request));
      return this.mutate(scope, request, url, data, async () => {
        const current = this.result(projectId, id), expected = this.conditional(request, current);
        const [item] = await this.host.move(projectId, { folderId: data.folderId, items: [{ id, version: current.version, folderVersion: current.folderVersion || 0 }] }, expected);
        return { status: 200, body: this.receipt(item), etag: localResultEtag(item) };
      });
    }
    if (parts.length === 4 && parts[2] === 'attachments' && method === 'DELETE') return this.mutate(scope, request, url, null, async () => {
      const current = this.result(projectId, id), expected = this.conditional(request, current);
      if (!current.localFiles?.some(file => file.id === parts[3])) return fail(404, 'not_found', '附件不存在');
      const item = await this.host.removeFile(id, parts[3], expected); return { status: 200, body: this.receipt(item), etag: localResultEtag(item) };
    });
    return fail(404, 'not_found', '接口不存在或不支持此方法');
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      const url = new URL(request.url || '/', this.base || 'http://127.0.0.1');
      const match = /^\/api\/v1\/projects\/([^/]+)\/(.*)$/.exec(url.pathname);
      if (!match) return this.reply(response, { status: 404, body: { error: { code: 'not_found', message: '接口不存在' } } });
      const projectId = decodeURIComponent(match[1]), parts = match[2].split('/').map(decodeURIComponent);
      const scope = this.authenticate(request, projectId);
      if (request.method !== 'GET' && (typeof request.headers['idempotency-key'] !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(request.headers['idempotency-key']))) fail(400, 'idempotency_key_required', '写入需要有效的 Idempotency-Key');
      await this.host.operate(async () => {
        this.authenticate(request, projectId);
        const reply = await this.route(scope, request, response, url, parts);
        if (reply) this.reply(response, reply);
      });
    } catch (error) { if (response.headersSent) response.destroy(); else this.reply(response, failure(error)); }
  }
  private reply(response: http.ServerResponse, reply: Reply) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(reply.etag ? { etag: reply.etag } : {}), ...(reply.replayed ? { 'idempotency-replayed': 'true' } : {}) });
    response.end(JSON.stringify(reply.body));
  }
  async close() {
    this.closed = true; this.grants.clear();
    const server = this.server; this.server = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await Promise.allSettled(this.requests); await this.mutations.catch(() => {});
    await Promise.all([...this.temporary].map(id => this.forgetTemporary(id)));
  }
}
