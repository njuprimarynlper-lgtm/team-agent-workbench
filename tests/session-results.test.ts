import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { refreshTeamCache } from '../src/core/team-cache';
import { sessionContext } from '../src/core/session-context';
import { sessionWithAvailableReferences } from '../src/shared/session-result-references';
import { currentResultSource } from '../src/shared/session-results';
import { accountIdentity } from '../src/shared/account-data';
import type { ProjectConclusion, AgentSession } from '../src/shared/types';
import type { SharedContent, ResultReference } from '../src/shared/content';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Local protocol fixture, no real account/model access.
import { authLauncher } from './fixtures/auth-launcher.mjs';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const fetchJson = (url: string, headers: Record<string, string> = {}, method = 'GET') => new Promise<{ status: number; body: any }>((resolve, reject) => {
  const request = http.request(url, { method, headers, agent: false }, response => { let body = ''; response.setEncoding('utf8'); response.on('data', part => { body += part; }); response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(body) })); });
  request.on('error', reject); request.end();
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-results-'));
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {}); await wb.store.init(); grantTestWorkspace(wb, root); await wb.projectSync.init();
  const s = await wb.createSession('codex', root, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  const file = path.join(root, 'personal.csv'); await fs.writeFile(file, 'personal attachment');
  const personal: ProjectConclusion = { id: randomUUID(), projectId: offlineProjectId, title: '个人测试成果', content: '个人成果正文', version: 1, sources: [], category: 'exploration', accountOwner: accountIdentity(s.binding!), updatedAt: new Date().toISOString(), localFiles: [{ id: randomUUID(), name: 'personal.csv', localPath: file, sha256: digest('personal attachment'), size: Buffer.byteLength('personal attachment') }] };
  wb.store.conclusions.push(personal);
  const team: SharedContent = { id: randomUUID(), title: '团队测试成果', description: '团队成果正文', revision: 1, kind: 'contribution', category: 'capability', path: '/projects/test/P/submissions/bob/result.md', author: 'bob', updatedBy: 'bob', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'submitted', sha256: digest('team body'), size: 9, attachments: [{ name: 'team.csv', sha256: digest('team attachment'), size: Buffer.byteLength('team attachment'), path: '/projects/test/P/.workbench-attachments/bob/' + digest('team attachment') }] };
  let online = false, downloads = 0;
  wb.projectConnected = () => online;
  wb.remote.contentList = async () => [team]; wb.remote.resultDirectories = async () => [];
  wb.remote.download = async (_binding, target, local) => { downloads++; assert.equal(target, team.attachments![0].path); await fs.writeFile(local, 'team attachment'); };
  await refreshTeamCache(wb, { action: 'content.list', projectId: offlineProjectId }, async () => [team]);
  await refreshTeamCache(wb, { action: 'result.directory.list', projectId: offlineProjectId }, async () => []);
  const ref = (scope: 'personal' | 'team'): ResultReference => ({ scope, projectId: offlineProjectId, id: scope === 'personal' ? personal.id : team.id, version: scope === 'personal' ? personal.version : team.revision });
  const indexes = async (session: AgentSession = s) => {
    const file = await wb.resultReferences.prepareContext(session); assert(file);
    const index = JSON.parse(await fs.readFile(file, 'utf8'));
    const entries = await Promise.all(index.results.map(async (entry: any) => JSON.parse(await fs.readFile(entry.indexPath, 'utf8'))));
    return { file, index, entries, urls: entries.flatMap((entry: any) => entry.attachments.map((file: any) => file.url as string)) };
  };
  return { root, wb, s, personal, team, ref, indexes, get downloads() { return downloads; }, online: (value: boolean) => { online = value; }, close: async () => { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); } };
}

test('current-project personal/team batch references freeze text and expose all attachment metadata without loading bytes', async () => {
  const f = await fixture();
  try {
    const team = await f.wb.resultReferences.candidates(f.s.id, 'team'); assert.equal(team.cached, true); assert.equal(team.items.length, 1);
    f.s.status = 'running'; const messages = structuredClone(f.s.messages);
    const result = await f.wb.resultReferences.attach(f.s.id, [f.ref('personal'), f.ref('team')]);
    assert.equal(result.added.length, 2); assert.equal(result.failed.length, 0); assert.equal(f.downloads, 0); assert.deepEqual(f.s.messages, messages); assert.equal(f.s.status, 'running');
    const body = await fs.readFile(result.added[0].source.localPath, 'utf8'); assert.match(body, /个人成果正文/); assert.match(body, /personal.csv/); assert(!body.includes('personal attachment'));
    const { urls, file } = await f.indexes(); assert.equal(urls.length, 2); assert.equal(f.downloads, 0);
    const wire = sessionContext(f.s, '继续', [], undefined, file); assert.equal(wire.sources.length, 2); assert(wire.text.includes(file)); assert(!wire.text.includes('team attachment'));
    const repeat = await f.wb.resultReferences.attach(f.s.id, [f.ref('personal'), f.ref('team')]); assert.deepEqual(repeat.added.map(item => item.source.id), result.added.map(item => item.source.id)); assert.equal(f.s.sources.length, 2);
  } finally { await f.close(); }
});

test('only requested attachments materialize, cache is reused offline and foreign links/paths are rejected', async () => {
  const f = await fixture();
  try {
    await f.wb.resultReferences.attach(f.s.id, [f.ref('personal'), f.ref('team')]); const { urls } = await f.indexes();
    const local = await fetchJson(urls[0]); assert.equal(local.status, 200); assert.equal(await fs.readFile(local.body.path, 'utf8'), 'personal attachment'); assert.equal(f.downloads, 0);
    const offline = await fetchJson(urls[1]); assert.equal(offline.status, 409); assert.match(offline.body.error, /尚未缓存/);
    f.online(true); const copies = await Promise.all(Array.from({ length: 4 }, () => fetchJson(urls[1]))); assert(copies.every(copy => copy.status === 200)); assert.equal(f.downloads, 1);
    f.online(false); assert.equal((await fetchJson(urls[1])).status, 200); assert.equal(f.downloads, 1);
    assert.equal((await fetchJson(urls[0], { Origin: 'https://example.com' })).status, 403);
    assert.equal((await fetchJson(urls[0], {}, 'POST')).status, 403);
    assert.equal((await fetchJson(urls[0] + '?path=C:/secret.txt')).status, 403);
    assert.equal((await fetchJson(urls[0].replace(f.s.id, randomUUID()))).status, 403);
    f.online(true); f.wb.remote.contentList = async () => { throw Error('没有此项目的访问权限'); };
    assert.match((await fetchJson(urls[1])).body.error, /访问权限/, 'authoritative denial also rejects a cached download');
    await f.wb.detachPendingSource(f.s.id, f.s.sources.find(source => source.resultLink?.reference.scope === 'personal')!.id);
    assert.equal((await fetchJson(urls[0])).status, 403);
  } finally { await f.close(); }
});

test('explicit version updates retain old snapshots and cancelling an unsent update restores the prior reference', async () => {
  const f = await fixture();
  try {
    const first = (await f.wb.resultReferences.attach(f.s.id, [f.ref('personal')])).added[0].source;
    f.s.nativeId = randomUUID(); const wire = sessionContext(f.s, '第一轮', []);
    f.s.messages.push({ id: randomUUID(), role: 'user', text: '第一轮', createdAt: new Date().toISOString(), context: { ...wire.context, accepted: true, nativeId: f.s.nativeId } });
    f.personal.version = 2; f.personal.content = '个人成果第二版';
    const retry = await f.wb.resultReferences.attach(f.s.id, [{ ...f.ref('personal'), version: 1 }]); assert.equal(retry.added[0].source.id, first.id, 'a retry keeps the exact frozen version even after the catalog advanced');
    const empty = await f.wb.createSession('codex', f.root, offlineProjectId);
    const stale = await f.wb.resultReferences.attach(empty.id, [{ ...f.ref('personal'), version: 1 }]); assert.equal(stale.failed.length, 1); assert.match(stale.failed[0].error, /版本已变化/);
    const next = (await f.wb.resultReferences.attach(f.s.id, [f.ref('personal')])).added[0].source;
    assert.equal(first.supersededBy, next.id); assert.match(await fs.readFile(first.localPath, 'utf8'), /个人成果正文/);
    assert.equal(sessionContext(sessionWithAvailableReferences(f.s, f.wb.store.conclusions), '第二轮', []).sources.length, 1);
    assert.equal(currentResultSource(f.s, f.ref('personal'))!.id, next.id);
    const history = await f.indexes();
    assert.deepEqual(history.index.results.map((entry: any) => [entry.reference.version, entry.active]), [[1, false], [2, true]]);
    await f.wb.resultReferences.restore();
    assert.deepEqual(JSON.parse(await fs.readFile(history.file, 'utf8')).results.map((entry: any) => entry.reference.version), [1, 2], 'reconnection cannot drop the index frozen for an in-flight send');
    assert.equal((await f.wb.attachConclusion(f.s.id, f.personal.id, 2)).id, next.id);
    await f.wb.detachPendingSource(f.s.id, next.id); assert.equal(first.supersededBy, undefined);
    await assert.rejects(f.wb.detachPendingSource(f.s.id, first.id), /已发送/);
  } finally { await f.close(); }
});

test('partial failures preserve successful references, retries deduplicate and mismatched attachment bytes never become readable', async () => {
  const f = await fixture();
  try {
    const results = await f.wb.resultReferences.attach(f.s.id, [f.ref('personal'), { ...f.ref('team'), projectId: 'other-project' }]); assert.equal(results.added.length, 1); assert.equal(results.failed.length, 1);
    assert.equal(f.s.sources.length, 1); assert.equal((await f.wb.attachConclusion(f.s.id, f.personal.id)).id, results.added[0].source.id);
    await fs.writeFile(f.personal.localFiles![0].localPath, 'tampered'); const { urls } = await f.indexes(); const bad = await fetchJson(urls[0]); assert.equal(bad.status, 409); assert.match(bad.body.error, /内容或版本不符/);
    f.s.codexRemote = { hostId: 'remote', hostName: 'remote', cwd: '/x', nativePath: '/x', home: '/x' };
    await assert.rejects(f.wb.resultReferences.attach(f.s.id, [f.ref('personal')]), /接入方式/);
  } finally { await f.close(); }
});

test('restart refreshes fixed indexes, preserves frozen bodies and keeps cached team attachments readable', async () => {
  const f = await fixture(); let second: Workbench | undefined;
  try {
    await f.wb.resultReferences.attach(f.s.id, [f.ref('team')]); const first = await f.indexes(); f.online(true); assert.equal((await fetchJson(first.urls[0])).status, 200);
    f.s.nativeId = randomUUID(); const wire = sessionContext(f.s, '运行', [], undefined, first.file);
    f.s.messages.push({ id: randomUUID(), role: 'user', text: '运行', createdAt: new Date().toISOString(), context: { ...wire.context, accepted: true, nativeId: f.s.nativeId } });
    const body = await fs.readFile(f.s.sources[0].localPath, 'utf8'); await f.wb.store.save(); await f.wb.close();
    second = new Workbench(path.join(f.root, 'data'), () => {}, () => {}); await second.store.init(); grantTestWorkspace(second, f.root); await second.projectSync.init(); await second.resultReferences.restore();
    const index = JSON.parse(await fs.readFile(first.file, 'utf8')), entry = JSON.parse(await fs.readFile(index.results[0].indexPath, 'utf8'));
    assert.notEqual(entry.attachments[0].url, first.urls[0]); assert.equal(await fs.readFile(second.session(f.s.id).sources[0].localPath, 'utf8'), body);
    assert.equal((await fetchJson(entry.attachments[0].url)).status, 200);
    const child = await second.createSession('cursor', f.root, offlineProjectId, 'work', undefined, undefined, 'inherit', false); child.sources = structuredClone(second.session(f.s.id).sources);
    const childIndex = await second.resultReferences.prepareContext(child); assert(childIndex && childIndex !== first.file);
    const childManifest = JSON.parse(await fs.readFile(childIndex, 'utf8')), childEntry = JSON.parse(await fs.readFile(childManifest.results[0].indexPath, 'utf8'));
    assert(childEntry.attachments[0].url.includes(child.id)); assert.equal((await fetchJson(childEntry.attachments[0].url)).status, 200);
  } finally { if (second) await second.close(); await f.close(); }
});

test('missing, changed, denied and cross-account attachments fail without substituting a newer file', async () => {
  const f = await fixture();
  try {
    await f.wb.resultReferences.attach(f.s.id, [f.ref('personal'), f.ref('team')]);
    const { urls } = await f.indexes();
    await fs.unlink(f.personal.localFiles![0].localPath);
    assert.match((await fetchJson(urls[0])).body.error, /附件已缺失/);
    f.online(true);
    f.wb.remote.contentList = async () => { throw Object.assign(Error('没有此项目的访问权限'), { code: 'PROJECT_ACCESS_REVOKED' }); };
    assert.match((await fetchJson(urls[1])).body.error, /访问权限/); assert.equal(f.downloads, 0);
    f.wb.remote.contentList = async () => [f.team];
    f.wb.remote.download = async (_binding, _remote, local) => { await fs.writeFile(local, 'a different revision'); };
    assert.match((await fetchJson(urls[1])).body.error, /版本不符/);
    // Even a valid URL from the previous owner never authorizes the new account.
    f.wb.store.settings.workspaceSnapshot!.profile.username = 'bob';
    assert.match((await fetchJson(urls[0])).body.error, /账号|项目/);
  } finally { await f.close(); }
});

test('an active turn and steering keep their original context; the next turn receives the new result once', async () => {
  const f = await fixture();
  try {
    const cliRoot = path.join(f.root, 'cli'), cli = await authLauncher(cliRoot, { status: 'ready', turn: 'hang' });
    f.wb.store.settings.providerPaths.codex = cli.launcher; f.wb.store.settings.codexRequestGuard = false;
    await f.wb.send(f.s.id, '第一轮任务');
    const firstMessages = f.s.messages.map(message => message.text);
    const attached = await f.wb.resultReferences.attach(f.s.id, [f.ref('personal')]);
    const source = attached.added[0].source;
    assert.deepEqual(f.s.messages.map(message => message.text), firstMessages);
    await f.wb.steer(f.s.id, 'fake-turn', '只补充本轮要求', [source.id]);
    const calls = async () => (await fs.readFile(path.join(cliRoot, 'rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const first = await calls();
    assert(!first.find(call => call.method === 'turn/start').params.input[0].text.includes('个人成果正文'));
    assert(!first.find(call => call.method === 'turn/steer').params.input[0].text.includes('个人成果正文'));
    assert(!first.find(call => call.method === 'turn/steer').params.input[0].text.includes('成果附件索引'));
    await f.wb.detachPendingSource(f.s.id, source.id); assert(!f.s.sources.some(item => item.id === source.id));
    await f.wb.resultReferences.attach(f.s.id, [f.ref('personal')]);
    await f.wb.stop(f.s.id);
    await cli.write({ status: 'ready', turn: 'success' });
    await f.wb.send(f.s.id, '下一轮任务');
    const next = (await calls()).filter(call => call.method === 'turn/start').at(-1).params.input[0].text;
    assert(next.includes('local-conclusion:' + f.personal.id)); assert(next.includes('成果附件索引')); assert(!next.includes('personal attachment'));
    const deadline = Date.now() + 10000;
    while (['starting', 'running', 'approval'].includes(f.s.status)) { assert(Date.now() < deadline, 'fixture turn finishes'); await new Promise(resolve => setTimeout(resolve, 20)); }
    await f.wb.send(f.s.id, '再继续');
    const repeat = (await calls()).filter(call => call.method === 'turn/start').at(-1).params.input[0].text;
    assert(!repeat.includes('local-conclusion:' + f.personal.id)); assert.equal(f.downloads, 0);
  } finally { await f.close(); }
});

test('a child can explicitly replace an inherited reference without losing its parent snapshot', async () => {
  const f = await fixture();
  try {
    const old = (await f.wb.resultReferences.attach(f.s.id, [f.ref('personal')])).added[0].source;
    const child = await f.wb.createSession('codex', f.root, offlineProjectId);
    child.sources = structuredClone(f.s.sources);
    child.fork = { parentId: f.s.id, sourceId: old.id, inheritedSourceIds: [old.id], capturedAt: '', parentMessageCount: 0, snapshotHash: old.sha256, workspaceKind: 'directory-copy', workspaceRoot: f.root };
    f.personal.version = 2; f.personal.content = '更新后的成果';
    const fresh = (await f.wb.resultReferences.attach(child.id, [f.ref('personal')])).added[0].source;
    const context = sessionContext(sessionWithAvailableReferences(child, f.wb.store.conclusions), '继续子会话', []);
    assert.deepEqual(context.sources.map(item => item.id), [fresh.id]);
    assert.equal(f.s.sources[0].supersededBy, undefined);
    assert((await fs.readFile(old.localPath, 'utf8')).includes('个人成果正文'));
  } finally { await f.close(); }
});

test('cancelling successive unsent updates restores only the preceding version, including skipped pending snapshots', async () => {
  const f = await fixture();
  try {
    const first = (await f.wb.resultReferences.attach(f.s.id, [f.ref('personal')])).added[0].source;
    f.s.messages.push({ id: randomUUID(), role: 'user', text: '已发送 v1', createdAt: '', context: { accepted: true, nativeId: 'n', workRecord: false, sourceHashes: { [first.id]: first.sha256 } } });
    f.personal.version = 2; const second = (await f.wb.resultReferences.attach(f.s.id, [f.ref('personal')])).added[0].source;
    f.personal.version = 3; const third = (await f.wb.resultReferences.attach(f.s.id, [f.ref('personal')])).added[0].source;
    await f.wb.detachPendingSource(f.s.id, third.id);
    assert.equal(first.supersededBy, second.id); assert.equal(second.supersededBy, undefined);
    assert.deepEqual(sessionWithAvailableReferences(f.s, f.wb.store.conclusions).sources.map(source => source.id), [second.id]);
    const replacement = (await f.wb.resultReferences.attach(f.s.id, [f.ref('personal')])).added[0].source;
    await f.wb.detachPendingSource(f.s.id, second.id);
    assert.equal(first.supersededBy, replacement.id, 'removing an intermediate pending version preserves the chain');
    await f.wb.detachPendingSource(f.s.id, replacement.id);
    assert.equal(first.supersededBy, undefined); assert.equal(f.s.sources.length, 1);
  } finally { await f.close(); }
});
