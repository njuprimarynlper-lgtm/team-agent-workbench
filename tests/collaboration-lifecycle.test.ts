import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from './fixtures/member-profile';
import { Workbench } from '../src/core/workbench';
import { preparationSnapshot } from '../src/core/preparation-snapshot';
import { contributionStatus } from '../src/shared/contribution-status';
import type { AgentSession, Draft, Transfer } from '../src/shared/types';
import { execFileSync } from 'node:child_process';
import { gitRevision } from '../src/core/git-revision';
import { contributionBody } from '../src/core/artifacts';

const brief = { background: '团队改进资料提取', objectives: '改进可靠性', acceptance: '按项目验收', scope: '', deliverables: '', resources: '', constraints: '', collaboration: '' };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-lifecycle-')), shared = path.join(root, 'share'); await fs.mkdir(shared);
  const admin = new LocalAdminConnection(() => {});
  await admin.connect({ mode: 'local', localRoot: shared, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
  await admin.operation({ op: 'initialize' });
  for (const label of ['relation', 'ocr']) await admin.operation({ op: 'group_create', label });
  for (const username of ['alice', 'bob', 'newbie']) await admin.operation({ op: 'user_create', username, name: username, password: '1', groups: username === 'newbie' ? [] : ['local_relation', 'local_ocr'], contentAdminGroups: username === 'alice' ? ['local_relation'] : username === 'bob' ? ['local_ocr'] : [] });
  const clients: Workbench[] = [];
  const connect = async (name: string) => { const wb = new Workbench(path.join(root, name), () => {}, () => {}); clients.push(wb); await wb.store.init(); await wb.configureWorkspace(memberProfile(admin.snapshot.profile!, admin.snapshot.state!, name), '1', root, async () => false); return wb; };
  const alice = await connect('alice'), bob = await connect('bob'), newbie = await connect('newbie');
  const project = await alice.createProject('实体抽取', 'local_relation', brief); await bob.refreshGroups();
  return { root, shared, admin, alice, bob, newbie, project, close: async () => { await Promise.all(clients.map(c => c.close())); admin.disconnect(); assert(root.startsWith(path.join(os.tmpdir(), 'team-lifecycle-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); } };
}
async function done(transfer: Transfer) { const end = Date.now() + 5000; while (['queued', 'running'].includes(transfer.status)) { if (Date.now() > end) throw new Error('queue stalled'); await new Promise(resolve => setTimeout(resolve, 20)); } }

test('one SSH identity spans groups; author revisions, admin curation, merge and cross-group denials', async () => {
  const x = await fixture();
  try {
    assert.equal(x.bob.remote.workspaces.find(g => g.groupName === 'local_ocr')!.canCreateProject, true);
    assert.equal(x.bob.remote.workspaces.find(g => g.groupName === 'local_relation')!.canCreateProject, false);
    const b = x.bob.remote.binding(x.project.id), a = x.alice.remote.binding(x.project.id), file = path.join(x.root, 'conclusion.md'); await fs.writeFile(file, '初始结论');
    await x.bob.remote.upload(b, file, b.project.uploadPath + '/结论.md', () => {}, { kind: 'contribution', title: '方案结论', description: '初始结论' });
    let item = (await x.bob.remote.contentList(b))[0];
    item = (await x.bob.remote.contentEdit(b, { id: item.id, revision: item.revision, action: 'save', title: '补充证据', description: '原作者补充', curate: false, merge: [] }))!;
    assert.equal(item.state, 'submitted');
    item = (await x.alice.remote.contentEdit(a, { id: item.id, revision: item.revision, action: 'save', title: '项目采用结论', description: '整理后的内容', curate: true, merge: [] }))!;
    assert.equal(item.state, 'curated'); assert.equal(item.author, 'bob'); assert.equal(item.updatedBy, 'alice');
    await assert.rejects(x.bob.remote.contentEdit(b, { id: item.id, revision: item.revision, action: 'delete', curate: false, merge: [] }), /尚未被/);
    await assert.rejects(x.bob.remote.upload(b, file, item.path, () => {}), /自己的公共/);
    await assert.rejects(x.newbie.createSession('codex', x.root, x.project.id), /没有加入工作组/);
    assert.equal(x.newbie.workspaceReady, false);
    const other = await x.bob.createProject('OCR', 'local_ocr'); await x.alice.refreshGroups();
    await assert.rejects(x.alice.remote.saveProjectBrief(x.alice.remote.binding(other.id), brief, 0), /子管理员/);
    await x.bob.remote.upload(b, file, b.project.uploadPath + '/补充.md', () => {}, { kind: 'contribution', title: '新的补充', description: '补充' });
    const second = (await x.bob.remote.contentList(b)).find(i => i.id !== item.id)!;
    const merged = await x.alice.remote.contentEdit(a, { id: item.id, revision: item.revision, action: 'save', title: '合并结论', description: '已合并', curate: true, merge: [{ id: second.id, revision: second.revision }] });
    assert.deepEqual(merged?.sources, [second.id]); assert.deepEqual(new Set(merged?.provenance?.map(source => source.id)), new Set([item.id, second.id])); assert.equal((await x.bob.remote.contentList(b)).length, 1);
  } finally { await x.close(); }
});

test('concurrent revisions have one winner; lost upload acknowledgement retries without duplicate content', async () => {
  const x = await fixture();
  try {
    const b = x.bob.remote.binding(x.project.id), file = path.join(x.root, 'result.md'); await fs.writeFile(file, 'report');
    const original = x.bob.remote.upload.bind(x.bob.remote); let lost = true;
    x.bob.remote.upload = async (...args) => { const result = await original(...args); if (lost) { lost = false; throw new Error('injected acknowledgement loss'); } return result; };
    const transfer = await x.bob.queue.enqueue(file, b, b.project.uploadPath, 'upload', undefined, { title: '报告', description: '结论', kind: 'contribution' }); await done(transfer);
    assert.equal(transfer.status, 'error'); assert.equal((await x.bob.remote.contentList(b)).length, 1);
    assert.equal(contributionStatus({ submitted: transfer.id } as Draft, transfer), '上传失败');
    await x.bob.queue.retry(transfer.id); await done(transfer); assert.equal(transfer.status, 'done'); assert(transfer.completedAt);
    const item = (await x.bob.remote.contentList(b))[0];
    const edit = { id: item.id, revision: item.revision, action: 'save' as const, title: '修改', description: '新内容', curate: false, merge: [] };
    const results = await Promise.allSettled([x.bob.remote.contentEdit(b, edit), x.alice.remote.contentEdit(x.alice.remote.binding(x.project.id), { ...edit, curate: true })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal((await x.bob.remote.contentList(b)).length, 1);
  } finally { await x.close(); }
});

test('project briefs are independently versioned; adopted session context stays frozen until explicit refresh', async () => {
  const x = await fixture();
  try {
    const second = await x.alice.createProject('另一个项目', 'local_relation'); const a = x.alice.remote.binding(second.id);
    assert.equal((await x.alice.remote.projectBrief(a)).revision, 0);
    await x.alice.remote.saveProjectBrief(a, brief, 0);
    await assert.rejects(x.alice.remote.saveProjectBrief(a, brief, 0), /已更新/);
    await x.bob.refreshGroups(); const s = await x.bob.createSession('codex', x.root, second.id);
    assert.equal(s.projectBrief?.revision, 1); const snapshot = s.sources.find(f => f.id === s.projectBrief?.sourceId)!; const old = await fs.readFile(snapshot.localPath, 'utf8');
    await x.alice.remote.saveProjectBrief(a, { ...brief, objectives: '第二版目标' }, 1);
    assert.equal(await fs.readFile(snapshot.localPath, 'utf8'), old); assert.equal(s.projectBrief?.revision, 1);
    await x.bob.refreshProjectContext(s.id); assert.equal(s.projectBrief?.revision, 2);
    assert((await fs.readFile(s.sources.find(f => f.id === s.projectBrief?.sourceId)!.localPath, 'utf8')).includes('第二版目标'));
    x.bob.remote.disconnect(); const offline = await x.bob.createSession('codex', x.root, second.id); assert(offline.binding);
    // Disconnected work carries no time limit: the same project keeps accepting new offline sessions.
    assert(await x.bob.createSession('cursor', x.root, second.id));
  } finally { await x.close(); }
});

test('last subadministrator changes require a successor or explicit vacancy, preserving other groups', async () => {
  const x = await fixture();
  try {
    const op = { op: 'group_member' as const, username: 'alice', group: 'local_relation', role: 'member' as const };
    await assert.rejects(x.admin.operation(op), /最后|失去子管理员/);
    assert(x.admin.snapshot.state!.users.alice.contentAdminGroups?.includes('local_relation'));
    await x.admin.operation({ ...op, handoffs: { local_relation: 'bob' } });
    assert.deepEqual(new Set(x.admin.snapshot.state!.users.bob.contentAdminGroups), new Set(['local_relation', 'local_ocr']));
    await assert.rejects(x.admin.operation({ op: 'user_enabled', username: 'bob', enabled: false }), /子管理员/);
    await x.admin.operation({ op: 'user_enabled', username: 'bob', enabled: false, handoffs: { local_relation: null, local_ocr: null } });
    assert.equal(x.admin.snapshot.state!.users.bob.enabled, false);
  } finally { await x.close(); }
});

test('preparation freezes conversation independently of absent notes and later turns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-snapshot-'));
  try {
    const s = { id: 'session', handoffPath: path.join(root, 'missing.md'), sources: [], messages: [{ id: 'm1', role: 'assistant', text: '只有对话里有的结论', createdAt: new Date().toISOString() }] } as unknown as AgentSession;
    const pending = preparationSnapshot(s, path.join(root, 'input')); s.messages[0].text = '后续变更';
    const result = await pending; assert.equal(result.snapshot.messageCount, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'input/conversation.json'), 'utf8'))[0].text, '只有对话里有的结论');
    assert(JSON.parse(await fs.readFile(path.join(root, 'input/source-index.json'), 'utf8')).noteWarning);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('trajectory deduplication, success timestamps and cache cleanup preserve source sessions', async () => {
  const x = await fixture();
  try {
    const s = await x.bob.createSession('codex', x.root, x.project.id);
    const [first, simultaneous] = await Promise.all([x.bob.archive(s.id), x.bob.archive(s.id)]); assert.equal(first.id, simultaneous.id); await done(first); assert.equal(first.status, 'done'); assert(s.lastArchiveAt);
    const second = await x.bob.archive(s.id); assert.equal(second.id, first.id);
    s.messages.push({ id: 'message', role: 'user', text: '新内容', createdAt: new Date().toISOString() });
    assert.equal(await x.bob.archive(s.id, true), undefined, 'automatic frequency is bounded');
    const third = await x.bob.archive(s.id); await done(third); assert.notEqual(third.id, first.id);
    const cleaned = await x.bob.cleanUploadCache(); assert.equal(cleaned.count, 2);
    assert(await fs.stat(s.handoffPath)); assert.equal(x.bob.store.sessions.length, 1);
    assert.equal((await x.alice.remote.contentList(x.alice.remote.binding(x.project.id))).filter(i => i.kind === 'trajectory').length, 2);
  } finally { await x.close(); }
});

test('file replacement respects author/admin revisions and reusable text snapshots keep source provenance', async () => {
  const x = await fixture();
  try {
    const b = x.bob.remote.binding(x.project.id), file = path.join(x.root, 'table.csv'); await fs.writeFile(file, 'v1');
    await x.bob.remote.upload(b, file, b.project.uploadPath + '/table.csv', () => {}, { kind: 'file', title: '统计结果', description: '统计说明' });
    const item = (await x.bob.remote.contentList(b))[0]; await fs.writeFile(file, 'v2');
    const change = { id: item.id, revision: 1, action: 'save' as const, title: '整理后的统计', description: '统一口径', curate: true, merge: [] };
    const replacement = await x.alice.remote.contentReplace(x.alice.remote.binding(x.project.id), change, file);
    assert.equal(replacement?.revision, 2); assert.equal(replacement?.state, 'curated');
    assert.equal((await x.bob.remote.preview(b, replacement!.path)).content, 'v2');
    await assert.rejects(x.bob.remote.contentReplace(b, { ...change, revision: 2, curate: false }, file), /尚未被/);
    const session = await x.bob.createSession('codex', x.root, x.project.id), source = await x.bob.attachContent(session.id, item.id);
    assert.match(await fs.readFile(source.localPath, 'utf8'), /统一口径/); assert.equal(source.sourcePath, replacement?.path);
    assert.match(await fs.readFile(source.localPath, 'utf8'), /维护人：alice/);
    const legacy = path.join(x.shared, ...b.project.remoteRoot.slice(1).split('/'), 'legacy.txt'); await fs.writeFile(legacy, '旧版共享资料');
    await assert.rejects(x.bob.remote.contentAdopt(b, b.project.remoteRoot + '/legacy.txt'), /子管理员/);
    const adopted = await x.alice.remote.contentAdopt(x.alice.remote.binding(x.project.id), b.project.remoteRoot + '/legacy.txt');
    assert.equal(adopted?.state, 'curated'); assert.match(adopted?.description || '', /旧版共享资料/);
  } finally { await x.close(); }
});

test('automatic trajectory upload waits for its interval and includes tool-only changes', async () => {
  const x = await fixture();
  try {
    const s = await x.bob.createSession('codex', x.root, x.project.id); s.autoUpload = true; x.bob.store.settings.autoUploadMinutes = 1;
    const original = await x.bob.archive(s.id); await done(original);
    const dir = x.bob.store.sessionDir(s.id); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'events.jsonl'), '{"tool":"new-evidence"}\n');
    s.lastTrajectoryQueuedAt = new Date(Date.now() - 59800).toISOString();
    assert.equal(await x.bob.archive(s.id, true), undefined);
    const deadline = Date.now() + 4000;
    while (x.bob.store.transfers.length !== 2) { assert(Date.now() < deadline); await new Promise(r => setTimeout(r, 25)); }
    await done(x.bob.store.transfers[0]); assert.equal(x.bob.store.transfers[0].status, 'done'); assert.notEqual(x.bob.store.transfers[0].trajectoryHash, original.trajectoryHash);
  } finally { await x.close(); }
});

test('optional Git snapshot reports committed, dirty, unborn and non-repository directories without uploading code', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-git-context-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  try {
    assert.equal(await gitRevision(root), undefined); git('init', '-b', 'main');
    assert.equal((await gitRevision(root))?.commit, undefined);
    await fs.writeFile(path.join(root, 'result.txt'), 'v1'); git('add', 'result.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
    const clean = (await gitRevision(root))!; assert.equal(clean.branch, 'main'); assert.equal(clean.commit, git('rev-parse', 'HEAD').trim()); assert.equal(clean.dirty, false);
    await fs.writeFile(path.join(root, 'result.txt'), 'v2'); const dirty = (await gitRevision(root))!; assert.equal(dirty.dirty, true);
    const draft = { body: '方向性结论', git: dirty, includeGit: true } as Draft;
    assert.match(contributionBody(draft), /commit 无法代表全部/); draft.includeGit = false; assert.equal(contributionBody(draft), '方向性结论');
  } finally { assert(root.startsWith(path.join(os.tmpdir(), 'team-git-context-'))); await fs.rm(root, { recursive: true, force: true }); }
});
