import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { Workbench } from '../src/core/workbench';
import { ContentFiles } from '../src/core/content-files';
import { conclusionPublicationOrigin, resolveConclusionPublication } from '../src/core/conclusion-sharing';
import { memberProfile } from './fixtures/member-profile';
import { syncedProject } from './fixtures/synced-project';
import type { ProjectConclusion, RemoteBinding } from '../src/shared/types';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-publication-life-')), shared = path.join(root, 'share'); await fs.mkdir(shared);
  const admin = new LocalAdminConnection(() => {});
  await admin.connect({ mode: 'local', localRoot: shared, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
  await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: 'publish' });
  for (const username of ['alice', 'bob']) await admin.operation({ op: 'user_create', username, name: username, password: '1', groups: ['local_publish'], contentAdminGroups: username === 'alice' ? ['local_publish'] : [] });
  const clients: Workbench[] = [];
  const connect = async (name: string) => { const wb = new Workbench(path.join(root, name), () => {}, () => {}); clients.push(wb); await wb.store.init(); await wb.configureWorkspace(memberProfile(admin.snapshot.profile!, admin.snapshot.state!, name), '1', root, async () => false); return wb; };
  const alice = await connect('alice'), bob = await connect('bob'), project = await syncedProject(alice, '成果发布', 'local_publish'); await bob.refreshGroups(); await bob.connectProject(project.id);
  const list = () => bob.remote.contentList(bob.remote.binding(project.id));
  return { root, alice, bob, project, list, close: async () => { await Promise.all(clients.map(wb => wb.close())); admin.disconnect(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); } };
}
async function settled(wb: Workbench) { const end = Date.now() + 15000; while (wb.store.transfers.some(item => ['queued', 'running'].includes(item.status))) { if (Date.now() > end) throw new Error('queue timeout'); await new Promise(resolve => setTimeout(resolve, 20)); } const failed = wb.store.transfers.find(item => item.status === 'error'); assert(!failed, failed?.error || 'upload failed'); }
const selected = (item: ProjectConclusion) => [{ id: item.id, version: item.version }];

test('member edits locally and republishes same team ID with history; direct edits/deletes are denied', async () => {
  const x = await fixture();
  try {
    const item = await x.bob.createConclusion(x.project.id, '初版', '原正文', 'exploration');
    await x.bob.publishConclusion(item.id); await settled(x.bob);
    const first = (await x.list())[0]; assert.equal(item.publication?.contentId, first.id); assert.equal(item.publication?.revision, 1);
    await assert.rejects(x.bob.editSharedContent(x.project.id, { id: first.id, revision: 1, action: 'save', title: '绕过', description: '无效', curate: false, merge: [] }), /成员不能直接/);
    await assert.rejects(x.bob.remote.contentEdit(x.bob.remote.binding(x.project.id), { id: first.id, revision: 1, action: 'save', title: '绕过', description: '无效', curate: false, merge: [] }), /成员不能直接/);
    await assert.rejects(x.bob.remote.contentEdit(x.bob.remote.binding(x.project.id), { id: first.id, revision: 1, action: 'delete', curate: false, merge: [] }), /成员不能直接/);
    await x.bob.saveConclusion(item.id, '新版标题', '新正文', 'capability', undefined, item.version);
    await x.bob.publishConclusion(item.id); await settled(x.bob);
    const all = await x.list(); assert.equal(all.length, 1); assert.equal(all[0].id, first.id); assert.equal(all[0].revision, 2); assert.equal(all[0].description, '新正文'); assert.equal(item.publication?.revision, 2);
    assert.equal((await x.bob.remote.contentHistory(x.bob.remote.binding(x.project.id), first.id, 1))[0].description, '原正文');
    const preview = await x.bob.previewConclusionDeletion(selected(item)); assert.equal(preview[0].status, 'linked');
    await x.bob.deleteConclusions(selected(item), true, preview); assert.equal((await x.list()).length, 0); assert(item.deletedAt);
  } finally { await x.close(); }
});

test('own imported copy updates exact origin; other members copies publish independently; missing and query failures differ', async () => {
  const x = await fixture();
  try {
    const binding = x.bob.remote.binding(x.project.id), source = path.join(x.root, 'legacy.md'); await fs.writeFile(source, 'original');
    const remote = await x.bob.remote.upload(binding, source, binding.project.uploadPath + '/explorations/legacy.md', () => {}, { kind: 'contribution', category: 'exploration', title: '旧发布', description: '旧正文' });
    const own = (await x.bob.importContentConclusion(x.project.id, remote.id)).conclusion;
    await x.bob.saveConclusion(own.id, '重导入修改', '修改正文', 'exploration', undefined, own.version); await x.bob.publishConclusion(own.id); await settled(x.bob);
    assert.equal((await x.list())[0].id, remote.id); assert.equal((await x.list())[0].revision, 2);
    const other = (await x.alice.importContentConclusion(x.project.id, remote.id)).conclusion;
    await x.alice.saveConclusion(other.id, '他人副本', '独立观点', 'exploration', undefined, other.version); await x.alice.publishConclusion(other.id); await settled(x.alice);
    assert.equal((await x.list()).length, 2); assert.notEqual(other.publication?.contentId, remote.id);
    const normalList = x.bob.remote.contentList.bind(x.bob.remote); x.bob.remote.contentList = async () => { throw new Error('网络断开'); };
    const unavailable = await x.bob.previewConclusionDeletion(selected(own)); assert.equal(unavailable[0].status, 'error'); assert.match(unavailable[0].message!, /网络断开/);
    await assert.rejects(x.bob.deleteConclusions(selected(own), true, unavailable), /网络断开/); assert(!own.deletedAt);
    x.bob.remote.contentList = normalList;
    await x.alice.editSharedContent(x.project.id, { id: remote.id, revision: 2, action: 'delete', curate: false, merge: [] });
    const gone = await x.bob.previewConclusionDeletion(selected(own)); assert.equal(gone[0].status, 'missing');
    const result = await x.bob.deleteConclusions(selected(own), true, gone); assert.deepEqual(result.missing, [own.title]); assert.equal((await x.list()).length, 1);
  } finally { await x.close(); }
});

test('publication baseline does not adopt a newer team revision; old server blocks before creating upload', async () => {
  const x = await fixture();
  try {
    const item = await x.bob.createConclusion(x.project.id, '并发', '原文', 'exploration'); await x.bob.publishConclusion(item.id); await settled(x.bob);
    await x.bob.saveConclusion(item.id, '并发', '本地修订', 'exploration', undefined, item.version);
    const support = x.bob.remote.contentPublicationSupport.bind(x.bob.remote); x.bob.remote.contentPublicationSupport = async () => { throw new Error('不支持的内容操作'); };
    const count = x.bob.store.transfers.length; await assert.rejects(x.bob.publishConclusion(item.id), /更新服务端/); assert.equal(x.bob.store.transfers.length, count); x.bob.remote.contentPublicationSupport = support;
    const binding = x.bob.remote.binding(x.project.id), file = path.join(x.root, 'concurrent.md'); await fs.writeFile(file, 'other machine');
    const origin = (await x.list())[0];
    await x.bob.remote.upload(binding, file, binding.project.uploadPath + '/explorations/concurrent.md', () => {}, { kind: 'contribution', category: 'exploration', title: '其他机器', description: '其他机器修改', publicationTarget: { id: origin.id, revision: 1 } });
    await assert.rejects(x.bob.publishConclusion(item.id), /已有新版本/); assert.equal((await x.list()).length, 1); assert.equal((await x.list())[0].description, '其他机器修改');
    assert.equal((await x.bob.previewConclusionDeletion(selected(item)))[0].status, 'error');
    const legacy = structuredClone(item); legacy.publication = { ...legacy.publication! }; delete legacy.publication.contentId; delete legacy.publication.revision;
    const resolved = resolveConclusionPublication(legacy, binding.username, await x.list(), await x.bob.remote.contentHistory(binding)); assert.equal(resolved?.status, 'linked'); assert.equal(resolved && 'revision' in resolved ? resolved.revision : 0, 1);
  } finally { await x.close(); }
});

test('local backend update retries are idempotent and cannot overwrite foreign or stale records', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-publish-backend-')); let actor = { username: 'alice', admin: false };
  const files = new ContentFiles(root, async () => actor), binding = { username: 'alice', project: { id: 'p', name: 'Fixture', remoteRoot: '/p', uploadPath: '/p/submissions/alice', historyPath: '/p/trajectories/alice' } } as RemoteBinding;
  try {
    const file = path.join(root, 'file.md'); await fs.writeFile(file, 'one'); const metadata = { kind: 'contribution' as const, title: 'first', description: 'one' };
    const first = await files.publish(binding, file, '/p/submissions/alice/first.md', metadata); await fs.writeFile(file, 'two');
    const update = { ...metadata, description: 'two', publicationTarget: { id: first.id, revision: first.revision } };
    const second = await files.publish(binding, file, '/p/submissions/alice/second.md', update); assert.equal(second.id, first.id); assert.equal(second.revision, 2);
    assert.deepEqual(await files.publish(binding, file, '/p/submissions/alice/second.md', update), second);
    await assert.rejects(files.publish(binding, file, '/p/submissions/alice/stale.md', update), /已有新版本/);
    actor = { username: 'bob', admin: true };
    await assert.rejects(files.publish(binding, file, '/p/submissions/bob/foreign.md', { ...update, publicationTarget: { id: first.id, revision: 2 } }), /自己发布/);
    assert.equal((await files.list(binding)).length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a combined local result never borrows one source publication as its own identity', () => {
  const item = { sources: [{ kind: 'session', id: 'one', publication: { contentId: randomUUID(), revision: 1, path: '/old.md', sha256: 'a'.repeat(64) } }, { kind: 'remote', id: 'two', revision: 1, path: '/another.md', sha256: 'b'.repeat(64) }] } as ProjectConclusion;
  assert.equal(conclusionPublicationOrigin(item), undefined);
  item.sources = [item.sources[0]]; assert.equal(conclusionPublicationOrigin(item)?.path, '/old.md');
});

test('editing while the first upload is active cannot publish or delete ahead of its receipt', async () => {
  const x = await fixture(); let release = () => {};
  try {
    const item = await x.bob.createConclusion(x.project.id, '上传中修改', '第一版', 'exploration');
    const upload = x.bob.remote.upload.bind(x.bob.remote), held = new Promise<void>(resolve => { release = resolve; });
    let entered = () => {}; const reached = new Promise<void>(resolve => { entered = resolve; });
    x.bob.remote.upload = async (...args) => { entered(); await held; return upload(...args); };
    await x.bob.publishConclusion(item.id); await reached;
    await x.bob.saveConclusion(item.id, item.title, '第二版', item.category, undefined, item.version);
    await assert.rejects(x.bob.publishConclusion(item.id), /先前版本仍在上传/);
    await assert.rejects(x.bob.deleteConclusions(selected(item)), /上传/);
    assert.equal(x.bob.store.transfers.length, 1); release(); await settled(x.bob);
    const first = (await x.list())[0]; await x.bob.publishConclusion(item.id); await settled(x.bob);
    const current = await x.list(); assert.equal(current.length, 1); assert.equal(current[0].id, first.id); assert.equal(current[0].revision, 2); assert.equal(current[0].description, '第二版');
  } finally { release(); await x.close(); }
});

test('an uncertain old upload must recover its original receipt before a newer local version can be shared', async () => {
  const x = await fixture();
  try {
    const item = await x.bob.createConclusion(x.project.id, '丢失回执', '第一版', 'exploration'), upload = x.bob.remote.upload.bind(x.bob.remote); let lost = true;
    x.bob.remote.upload = async (...args) => { const receipt = await upload(...args); if (lost) { lost = false; throw new Error('模拟上传成功但回执丢失'); } return receipt; };
    const first = await x.bob.publishConclusion(item.id); const end = Date.now() + 5000;
    while (first.status !== 'error' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(first.status, 'error'); assert.equal(first.phase, 'verifying');
    await x.bob.saveConclusion(item.id, item.title, '第二版', item.category, undefined, item.version);
    await assert.rejects(x.bob.publishConclusion(item.id), /旧版本上传尚未完成确认/);
    await assert.rejects(x.bob.deleteConclusions(selected(item)), /原上传结果/);
    assert.equal(x.bob.store.transfers.length, 1); assert.equal((await x.list()).length, 1);
    await x.bob.queue.retry(first.id); await settled(x.bob); const remoteId = item.publication!.contentId;
    await x.bob.publishConclusion(item.id); await settled(x.bob);
    assert.equal((await x.list()).length, 1); assert.equal((await x.list())[0].id, remoteId); assert.equal((await x.list())[0].revision, 2);
  } finally { await x.close(); }
});
