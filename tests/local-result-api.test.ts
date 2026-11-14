import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Workbench } from '../src/core/workbench';
import type { LocalResultApiConfig } from '../src/shared/local-result-api';
import { localResultApiMarker } from '../src/shared/local-result-context';
import { recoverSessionContext } from '../src/shared/session-context-text';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

const execute = promisify(execFile);
type Response = { status: number; body: any; bytes: Buffer; etag?: string; replayed?: string };
function request(config: LocalResultApiConfig, route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const raw = Buffer.isBuffer(body) ? body : body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const call = http.request(config.baseUrl + route, { method, agent: false, headers: { authorization: 'Bearer ' + config.token, ...(raw ? { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'content-length': String(raw.length) } : {}), ...headers } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { const bytes = Buffer.concat(chunks), json = response.headers['content-type']?.startsWith('application/json'); resolve({ status: response.statusCode!, body: json ? JSON.parse(bytes.toString('utf8')) : undefined, bytes, etag: response.headers.etag, replayed: response.headers['idempotency-replayed'] as string | undefined }); });
    }); call.on('error', reject); call.end(raw);
  });
}
const writeHeaders = (etag?: string, key = randomUUID()) => ({ 'idempotency-key': key, ...(etag ? { 'if-match': etag } : {}) });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-result-api-'));
  let wb = new Workbench(path.join(root, 'data'), () => {}, () => {}); await wb.store.init(); grantTestWorkspace(wb, root);
  const session = await wb.createSession('codex', root, offlineProjectId);
  const configPath = path.join(wb.store.sessionDir(session.id), 'results-api.json');
  let config: LocalResultApiConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
  return {
    root, session, configPath, get wb() { return wb; }, get config() { return config; },
    call: (route: string, method = 'GET', body?: unknown, headers?: Record<string, string>) => request(config, route, method, body, headers),
    create: async (data: unknown = { title: '验证结果', content: '## 结论\n尚未覆盖全部场景。', category: 'exploration' }) => { const response = await request(config, '/results', 'POST', data, writeHeaders()); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body as { id: string; etag: string; version: number }; },
    restart: async () => { await wb.close(); wb = new Workbench(path.join(root, 'data'), () => {}, () => {}); await wb.store.init(); grantTestWorkspace(wb, root); await wb.resultApi.restore(); config = JSON.parse(await fs.readFile(configPath, 'utf8')); },
    close: async () => { await wb.close(); await fs.rm(root, { recursive: true, force: true }); },
  };
}

test('local REST writes use the existing personal library and version history, without a central connection', async () => {
  const f = await fixture();
  try {
    assert.equal(f.wb.remote.connected, false);
    const created = await f.create(); assert.equal(created.version, 1);
    assert.equal(f.wb.conclusions(offlineProjectId).length, 1);
    const read = await f.call('/results/' + created.id); assert.equal(read.status, 200); assert.equal(read.etag, created.etag); assert.match(read.body.content, /尚未覆盖/);
    const update = await f.call('/results/' + created.id, 'PATCH', { content: '## 结论\n新增独立验证，边界仍待补测。' }, writeHeaders(read.etag));
    assert.equal(update.status, 200); assert.equal(update.body.version, 2); assert.notEqual(update.etag, read.etag);
    const item = f.wb.conclusions(offlineProjectId)[0]; assert.equal(item.versions?.[0].version, 1); assert.match(item.versions![0].content, /尚未覆盖/);
    const stale = await f.call('/results/' + created.id, 'PATCH', { content: 'stale' }, writeHeaders(read.etag)); assert.equal(stale.status, 412);
    const missing = await f.call('/results/' + created.id, 'PATCH', { content: 'unconditional' }, writeHeaders()); assert.equal(missing.status, 428);
    const list = await f.call('/results?q=' + encodeURIComponent('独立验证') + '&offset=0&limit=1'); assert.equal(list.body.total, 1); assert.equal(list.body.items[0].content, undefined);
    assert.equal((await f.call('/results?limit=1000')).status, 400);
  } finally { await f.close(); }
});

test('idempotent creates and updates replay their receipts; changed payloads cannot reuse a key', async () => {
  const f = await fixture();
  try {
    const key = randomUUID(), data = { title: '同一次操作', content: '原始正文' };
    const [first, again] = await Promise.all([f.call('/results', 'POST', data, writeHeaders(undefined, key)), f.call('/results', 'POST', data, writeHeaders(undefined, key))]);
    assert.equal(first.status, 200); assert.equal(again.status, 200); assert.equal(first.body.id, again.body.id); assert.equal(again.replayed, 'true'); assert.equal(f.wb.conclusions(offlineProjectId).length, 1);
    assert.equal((await f.call('/results', 'POST', { ...data, content: 'different' }, writeHeaders(undefined, key))).status, 409);
    const headers = writeHeaders(first.etag), route = '/results/' + first.body.id;
    const update = await f.call(route, 'PATCH', { content: 'new' }, headers);
    const retry = await f.call(route, 'PATCH', { content: 'new' }, headers); assert.equal(retry.status, 200); assert.equal(retry.replayed, 'true'); assert.deepEqual(retry.body, update.body);
    assert.equal(f.wb.conclusions(offlineProjectId)[0].version, 2);
  } finally { await f.close(); }
});

test('scoped grants reject browser origins, spoofed hosts, other projects/accounts and expired account epochs', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('/context', 'GET', undefined, { authorization: '' })).status, 401);
    assert.equal((await f.call('/context', 'GET', undefined, { origin: 'http://evil.invalid' })).status, 403);
    assert.equal((await f.call('/context', 'GET', undefined, { host: 'evil.invalid' })).status, 403);
    const other = structuredClone(f.config); other.baseUrl = other.baseUrl.replace(offlineProjectId, 'project_' + 'b'.repeat(32)); assert.equal((await request(other, '/results')).status, 403);
    const profile = f.wb.store.settings.workspaceSnapshot!.profile; profile.username = 'bob';
    assert.equal((await f.call('/results')).status, 403); profile.username = 'alice';
    (f.wb as any).accountRevision++; assert.equal((await f.call('/results')).status, 403);
    const fresh = await f.wb.resultApi.prepare(f.session); assert(fresh); const config = JSON.parse(await fs.readFile(fresh.configPath, 'utf8'));
    assert.equal((await request(config, '/context')).status, 200);
    const invalid = await request(config, '/results', 'POST', { projectId: 'another', title: 'title', content: 'content' }, writeHeaders()); assert.equal(invalid.status, 400);
  } finally { await f.close(); }
});

test('attachment bytes stream into frozen files, replay without duplicates, and attachment-only changes invalidate old ETags', async () => {
  const f = await fixture();
  try {
    const created = await f.create(), bytes = Buffer.from([0, 255, 1, 2, 13, 10, 128]), headers = writeHeaders(created.etag), route = '/results/' + created.id;
    const upload = await f.call(route + '/attachments?name=' + encodeURIComponent('实验数据.bin'), 'POST', bytes, headers); assert.equal(upload.status, 200, JSON.stringify(upload.body));
    assert.equal(upload.body.version, 1); assert.notEqual(upload.etag, created.etag); assert.equal(upload.body.attachments.length, 1);
    const retry = await f.call(route + '/attachments?name=' + encodeURIComponent('实验数据.bin'), 'POST', bytes, headers); assert.equal(retry.replayed, 'true'); assert.equal(retry.status, 200);
    assert.equal(f.wb.conclusions(offlineProjectId)[0].localFiles!.length, 1);
    const attachment = upload.body.attachments[0]; assert.equal(attachment.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(attachment.localPath, undefined);
    const download = await f.call(route + '/attachments/' + attachment.id); assert.equal(download.status, 200); assert.deepEqual(download.bytes, bytes);
    assert.equal((await f.call(route, 'PATCH', { content: 'stale after attachment' }, writeHeaders(created.etag))).status, 412);
    const remove = await f.call(route + '/attachments/' + attachment.id, 'DELETE', undefined, writeHeaders(upload.etag)); assert.equal(remove.status, 200); assert.equal(remove.body.attachments.length, 0);
    assert.equal((await f.call(route + '/attachments/' + attachment.id)).status, 404);
    assert.deepEqual(await fs.readdir(path.join(f.wb.store.root, 'local-result-api', 'uploads')), []);
  } finally { await f.close(); }
});

test('unsafe attachment names, unsupported payloads and oversized declared uploads are rejected', async () => {
  const f = await fixture();
  try {
    const created = await f.create(), route = '/results/' + created.id + '/attachments';
    for (const name of ['../secret', 'file:stream', 'NUL.txt', 'a\\b', 'trailing.']) assert.equal((await f.call(route + '?name=' + encodeURIComponent(name), 'POST', Buffer.from('x'), writeHeaders(created.etag))).status, 400);
    assert.equal((await f.call(route + '?name=ok.txt', 'POST', { localPath: 'C:/private' }, writeHeaders(created.etag))).status, 415);
    const oversized = await f.call(route + '?name=ok.txt', 'POST', undefined, { ...writeHeaders(created.etag), 'content-type': 'application/octet-stream', 'content-length': String(2 * 1024 ** 3 + 1) }); assert.equal(oversized.status, 413);
    assert.equal(f.wb.conclusions(offlineProjectId)[0].localFiles, undefined);
  } finally { await f.close(); }
});

test('directory moves, archive, restore and deletion share the UI library and never delete team results', async () => {
  const f = await fixture();
  try {
    const folder = randomUUID();
    assert.equal((await f.call('/directories', 'POST', { action: 'create', id: folder, parentId: 'exploration', name: '验证记录' }, writeHeaders())).status, 200);
    const created = await f.create(); let etag = created.etag; const route = '/results/' + created.id;
    const move = await f.call(route + '/move', 'POST', { folderId: folder }, writeHeaders(etag)); assert.equal(move.status, 200); etag = move.etag!;
    assert.equal(f.wb.conclusions(offlineProjectId)[0].folderId, folder);
    const archive = await f.call(route + '/archive', 'POST', { archived: true }, writeHeaders(etag)); assert.equal(archive.status, 200); etag = archive.etag!;
    assert.equal(f.wb.conclusions(offlineProjectId).length, 0); assert.equal((await f.call('/results?includeArchived=true')).body.total, 1);
    const restore = await f.call(route + '/archive', 'POST', { archived: false }, writeHeaders(etag)); assert.equal(restore.status, 200); etag = restore.etag!;
    const headers = writeHeaders(etag), removed = await f.call(route, 'DELETE', undefined, headers); assert.equal(removed.status, 200); assert.equal(removed.body.teamDeleted, false);
    assert.equal((await f.call(route)).status, 404); assert.equal((await f.call(route, 'DELETE', undefined, headers)).replayed, 'true');
  } finally { await f.close(); }
});

test('disk failures roll back file and body changes; newer UI edits win over stale API writes', async () => {
  const f = await fixture();
  try {
    const created = await f.create(), route = '/results/' + created.id, save = f.wb.store.save.bind(f.wb.store);
    f.wb.store.save = async () => { throw Object.assign(Error('disk busy'), { code: 'ENOSPC' }); };
    const upload = await f.call(route + '/attachments?name=failed.txt', 'POST', Buffer.from('x'), writeHeaders(created.etag)); assert.equal(upload.status, 500); assert.equal(f.wb.conclusions(offlineProjectId)[0].localFiles, undefined);
    const directory = path.join(f.wb.store.root, 'conclusion-files', created.id); assert.deepEqual(await fs.readdir(directory), []);
    const patch = await f.call(route, 'PATCH', { content: 'failed update' }, writeHeaders(created.etag)); assert.equal(patch.status, 500); assert.equal(f.wb.conclusions(offlineProjectId)[0].version, 1);
    f.wb.store.save = save;
    const item = f.wb.conclusions(offlineProjectId)[0]; await f.wb.saveConclusion(item.id, item.title, 'UI new content', undefined, undefined, item.version);
    assert.equal((await f.call(route, 'PATCH', { content: 'old AI content' }, writeHeaders(created.etag))).status, 412); assert.equal(item.content, 'UI new content');
  } finally { await f.close(); }
});

test('a UI edit between HTTP validation and the serialized write is detected inside the shared mutation queue', async () => {
  const f = await fixture();
  try {
    const created = await f.create(), save = f.wb.saveConclusion.bind(f.wb);
    f.wb.saveConclusion = async (...args: Parameters<Workbench['saveConclusion']>) => {
      if (args[7]) await save(args[0], args[1], 'UI edit committed while API was waiting', undefined, undefined, args[5]);
      return save(...args);
    };
    const response = await f.call('/results/' + created.id, 'PATCH', { content: 'AI stale patch' }, writeHeaders(created.etag));
    assert.equal(response.status, 412); assert.equal(f.wb.conclusions(offlineProjectId)[0].content, 'UI edit committed while API was waiting');
    assert.equal(f.wb.conclusions(offlineProjectId)[0].version, 2);
  } finally { await f.close(); }
});

test('restart refreshes descriptors while durable receipts prevent a repeated create', async () => {
  const f = await fixture();
  try {
    const headers = writeHeaders(), body = { title: '重启验证', content: 'body' };
    const first = await f.call('/results', 'POST', body, headers), previous = f.config;
    await f.restart(); assert.notEqual(f.config.token, previous.token); assert.equal(f.config.projectId, previous.projectId);
    const retry = await f.call('/results', 'POST', body, headers); assert.equal(retry.status, 200); assert.equal(retry.replayed, 'true'); assert.equal(retry.body.id, first.body.id);
    assert.equal(f.wb.conclusions(offlineProjectId).length, 1);
  } finally { await f.close(); }
});

test('pending receipts are not automatically replayed after an uncertain operation', async () => {
  const f = await fixture();
  try {
    const headers = writeHeaders(), body = { title: 'uncertain', content: 'body' }, created = await f.call('/results', 'POST', body, headers);
    const root = path.join(f.wb.store.root, 'local-result-api', 'requests');
    const find = async (directory: string): Promise<string[]> => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? find(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
    const file = (await find(root))[0], receipt = JSON.parse(await fs.readFile(file, 'utf8')); receipt.state = 'pending'; delete receipt.reply; await fs.writeFile(file, JSON.stringify(receipt));
    const retry = await f.call('/results', 'POST', body, headers); assert.equal(retry.status, 409); assert.equal(retry.body.error.code, 'operation_interrupted'); assert.equal(retry.body.error.resultId, created.body.id);
    assert.equal(f.wb.conclusions(offlineProjectId).length, 1);
  } finally { await f.close(); }
});

test('the distributed client performs Markdown creation, conditional edits, uploads and downloads through the real API', async () => {
  const f = await fixture();
  try {
    const client = f.config.clientPath;
    const run = async (...args: string[]) => JSON.parse((await execute(process.execPath, [client, '--config', f.configPath, ...args], { windowsHide: true })).stdout);
    assert.equal((await run('context')).data.projectId, offlineProjectId);
    const input = path.join(f.root, 'input.json'); await fs.writeFile(input, '\uFEFF' + JSON.stringify({ title: 'CLI 创建', content: '# Markdown\n\n**结论**与 `代码`', category: 'exploration' }));
    const created = await run('create', '--input', input, '--request-id', randomUUID()); assert.equal(created.status, 200);
    const read = await run('get', '--id', created.data.id), etagFile = path.join(f.root, 'etag.json'); await fs.writeFile(etagFile, '\uFEFF' + JSON.stringify(read), 'utf16le');
    const file = path.join(f.root, 'source.csv'); await fs.writeFile(file, 'a,b\n1,2\n');
    const upload = await run('upload', '--id', created.data.id, '--file', file, '--etag-file', etagFile); assert.equal(upload.status, 200);
    const output = path.join(f.root, 'download.csv'); await run('download', '--id', created.data.id, '--file-id', upload.data.attachments[0].id, '--output', output); assert.equal(await fs.readFile(output, 'utf8'), 'a,b\n1,2\n');
    await assert.rejects(run('download', '--id', created.data.id, '--file-id', upload.data.attachments[0].id, '--output', output)); assert.equal(await fs.readFile(output, 'utf8'), 'a,b\n1,2\n');
    await fs.writeFile(etagFile, JSON.stringify(upload)); await fs.writeFile(input, JSON.stringify({ content: 'updated by client' }));
    const updated = await run('update', '--id', created.data.id, '--input', input, '--etag-file', etagFile); assert.equal(updated.data.version, 2);
    const schema = await run('schema'); assert.equal(schema.data.openapi, '3.1.0'); assert(schema.data.paths['/results/{id}'].patch);
    assert(!JSON.stringify(read).includes(f.config.token));
  } finally { await f.close(); }
});

test('session guidance is delivered once per native conversation and hidden from legacy visible user messages', async () => {
  const f = await fixture();
  try {
    f.session.nativeId = 'native';
    const notice = await f.wb.resultApi.context(f.session); assert(notice.includes(localResultApiMarker)); assert(notice.includes(JSON.stringify(f.configPath))); assert(!notice.includes(f.config.token));
    assert.equal(recoverSessionContext(f.session, 'user text' + notice).userText, 'user text');
    assert.equal(recoverSessionContext({ ...f.session, id: randomUUID() }, 'user text' + notice).userText, 'user text' + notice);
    f.session.messages.push({ id: randomUUID(), role: 'user', text: 'user text' + notice, createdAt: new Date().toISOString(), context: { nativeId: 'native', accepted: true, workRecord: false, sourceHashes: {} } });
    assert.equal(await f.wb.resultApi.context(f.session), ''); f.session.nativeId = 'new-native'; assert((await f.wb.resultApi.context(f.session)).includes(localResultApiMarker));
    assert.equal(await f.wb.resultApi.prepare({ ...f.session, cursorNative: { } as any }), undefined);
  } finally { await f.close(); }
});

test('Codex, Cursor CLI and Claude work sessions receive project-bound descriptors, while remote/native sessions do not', async () => {
  const f = await fixture();
  try {
    for (const provider of ['codex', 'cursor', 'claude'] as const) {
      const session = await f.wb.createSession(provider, f.root, offlineProjectId);
      const paths = await f.wb.resultApi.prepare(session); assert(paths);
      const config = JSON.parse(await fs.readFile(paths.configPath, 'utf8')) as LocalResultApiConfig;
      assert.equal((await request(config, '/context')).body.projectId, offlineProjectId);
      assert((await fs.readFile(config.skillPath, 'utf8')).includes('name: workbench-results'));
      assert.equal(await f.wb.resultApi.prepare({ ...session, codexRemote: {} as any }), undefined);
    }
  } finally { await f.close(); }
});

test('temporary chat descriptors stay outside ordinary session storage and are removed on close', async () => {
  const f = await fixture();
  try {
    const temporary = { ...f.session, id: randomUUID(), nativeId: 'temporary-native', messages: [] };
    const descriptor = await f.wb.resultApi.prepare(temporary); assert(descriptor);
    assert(descriptor.configPath.includes(path.join('local-result-api', 'temporary', temporary.id)));
    await assert.rejects(fs.stat(f.wb.store.sessionDir(temporary.id)), { code: 'ENOENT' });
    const notice = await f.wb.resultApi.context(temporary); assert.equal(recoverSessionContext(temporary, 'question' + notice).userText, 'question');
    await f.wb.resultApi.forgetTemporary(temporary.id); await assert.rejects(fs.stat(descriptor.configPath), { code: 'ENOENT' });
    assert(!f.wb.store.sessions.some(item => item.id === temporary.id));
  } finally { await f.close(); }
});
