import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { applyPreparation, contributionDirectory, discoverDestinations } from '../src/core/preparation';
import type { Draft, RemoteBinding } from '../src/shared/types';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from './fixtures/member-profile';
import { diskPath } from '../src/core/local-space';
// @ts-expect-error JS protocol fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';
// @ts-expect-error JS SFTP fixture.
import { teamServer } from './fixtures/team-server.mjs';
async function until(fn: () => boolean) { const end = Date.now() + 20000; while (!fn()) { if (Date.now() > end) throw new Error('test timed out'); await new Promise(r => setTimeout(r, 20)); } }
const binding: RemoteBinding = { connectionId: 'c', host: 'local', port: 22, username: 'alice', fingerprint: 'f', project: { id: 'p', name: '项目', remoteRoot: '/p', uploadPath: '/p/submissions/alice', historyPath: '/p/trajectories/alice' } };
const result = { title: '更新说明', body: '已完成的验证与限制。', repoUrl: 'https://github.com/owner/repo', destinationId: 'default' };

test('structured results classify independent artifacts, keep only category fields and use fixed paths', () => {
  const d = { id: 'draft', binding, body: '', supplement: '人补充的说明', repoUrlOverride: 'https://github.com/human/repo', preparationVersion: 3 } as Draft;
  applyPreparation(d, '```json\n' + JSON.stringify({ artifacts: [
    { category: 'experiment_result', title: '阈值实验', fields: { objective: '验证阈值', result: 'F1 提升 1.2', unknown: '不得保留' }, repoUrl: 'https://github.com/owner/repo' },
    { category: 'baseline_change_proposal', title: '调整验收阈值', fields: { baselineItem: 'F1 下限', proposedValue: '0.91', rationale: '新数据分布' } }
  ] }) + '\n```');
  assert.equal(d.artifacts?.length, 2); assert.equal(d.artifacts?.[0].target, '/p/submissions/alice/experiments'); assert.equal(d.artifacts?.[1].target, '/p/submissions/alice/baseline-change-proposals');
  assert.equal(d.artifacts?.[0].fields.unknown, undefined); assert.match(d.artifacts?.[0].body || '', /F1 提升/); assert.equal(d.supplement, '人补充的说明'); assert.equal(d.repoUrlOverride, 'https://github.com/human/repo');
  applyPreparation(d, JSON.stringify({ ...result, repoUrl: 'https://github.com/owner/repo/pull/123' })); assert.equal(d.repoUrl, ''); assert.equal(d.target, '/p/submissions/alice/findings');
  assert.throws(() => applyPreparation(d, 'A partial or malformed answer'), /格式不完整/);
  for (const p of ['/outside', '/p/../other', '/p/trajectories', '/p/submissions/bob', '/p/.workbench']) assert.throws(() => contributionDirectory(binding, p));
});

test('local shared filesystem: discover descriptions, auto destination, explicit upload, immutable package, teammate visibility and live permission denial', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prepare-local-')), share = path.join(root, 'share'); await fs.mkdir(share);
  const admin = new LocalAdminConnection(() => {}), wb = new Workbench(path.join(root, 'alice'), () => {}, () => {}), bob = new Workbench(path.join(root, 'bob'), () => {}, () => {});
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success', turnDelay: 500 });
  try {
    await admin.connect({ mode: 'local', localRoot: share, root: '/srv/teamspace', host: 'local', port: 22, username: 'admin', fingerprint: '' }, 'admin-password', '', async () => false);
    await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: 'prepare' });
    for (const username of ['alice', 'bob']) await admin.operation({ op: 'user_create', username, name: username, password: 'member-password', groups: ['local_prepare'], contentAdminGroups: username === 'alice' ? ['local_prepare'] : [] });
    const profile = (username: string) => memberProfile(admin.snapshot.profile!, admin.snapshot.state!, username, 'local_prepare');
    await wb.store.init(); wb.store.settings.providerPaths.codex = fixture.launcher;
    await wb.configureWorkspace(profile('alice'), 'member-password', root, async () => false);
    const p = await wb.createProject('整理成果测试'), dir = p.remoteRoot + '/方案说明';
    const diskDir = await diskPath(share, dir, true); await fs.mkdir(diskDir); await fs.writeFile(path.join(diskDir, 'README.md'), '此目录接收设计与方案修改说明。');
    const candidates = await discoverDestinations(wb.remote, wb.remote.binding(p.id), () => true);
    const selected = candidates.destinations.find(x => x.path === dir)!; assert(selected); assert.match(selected.description, /设计与方案/);
    assert(!candidates.destinations.some(x => x.path.includes('trajectories')));
    await fixture.write({ status: 'ready', turn: 'success', turnDelay: 800, preparationResult: { ...result, destinationId: selected.id } });
    const s = await wb.createSession('codex', root, p.id);
    await wb.saveHandoff(s.id, '# 已完成\nhttps://github.com/owner/repo\n材料原始内容');
    const [d, same] = await Promise.all([wb.prepare(s.id), wb.prepare(s.id)]); assert.equal(d.id, same.id);
    await wb.saveDraftSupplement(d.id, '人工补充：下轮补充边界用例。', '');
    await assert.rejects(wb.submitDraft(d.id));
    await until(() => d.generation === 'ready'); assert.equal(d.target, p.uploadPath + '/findings'); assert.equal(wb.store.transfers.length, 0); assert(d.generationStartedAt); assert(d.generationFinishedAt);
    assert.equal((await wb.prepare(s.id)).id, d.id, 'ready contribution opens the same panel');
    await assert.rejects(wb.submitDraft(d.id, p.remoteRoot + '/trajectories/alice'), /不能在提交时改变/);
    // Refresh from the latest handoff only when explicitly regenerating completed work.
    await wb.saveHandoff(s.id, '# 新材料\n用户继续推进后的交接');
    await wb.retryPreparation(d.id); await until(() => d.generation === 'ready');
    const index = JSON.parse(await fs.readFile(path.join(d.inputDir, 'source-index.json'), 'utf8'));
    assert.match(await fs.readFile(index.handoff.localPath, 'utf8'), /继续推进/);
    assert.match(d.supplement!, /人工补充/);
    await fixture.write({ status: 'ready', turn: 'success', preparationResult: { artifacts: [
      { category: 'finding', title: '方向性结论', fields: { statement: '建议先验证数据覆盖率。', evidence: '当前材料显示收益尚未验证。' }, repoUrl: '' },
      { category: 'issue', title: '覆盖率风险', fields: { problem: '数据覆盖不足', impact: '收益判断可能失真' } }
    ] } });
    await wb.retryPreparation(d.id); await until(() => d.generation === 'ready'); assert.equal(d.repoUrl, ''); assert.equal(d.artifacts?.length, 2);
    const transfer = await wb.submitDraft(d.id); await until(() => wb.store.transfers.slice(0, 2).every(item => !['queued', 'running'].includes(item.status))); assert.equal(transfer.status, 'done', transfer.error || '');
    assert.deepEqual(new Set(wb.store.transfers.slice(0, 2).map(item => path.posix.dirname(item.target))), new Set([p.uploadPath + '/findings', p.uploadPath + '/issues']));
    const zip = JSON.parse(execFileSync('python', ['-c', 'import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:z.read(n).decode("utf-8") for n in z.namelist()}))', transfer.localPath], { encoding: 'utf8' }));
    const manifest = JSON.parse(zip['manifest.json']);
    assert.deepEqual(Object.keys(zip).sort(), ['README.md', 'manifest.json']); assert.match(zip['README.md'], /建议先验证数据覆盖率/); assert.equal('repoUrl' in manifest, false); assert.equal(manifest.schemaVersion, 4); assert.equal(manifest.category, 'finding'); assert.equal(manifest.snapshotHash, d.snapshot?.conversationHash); assert.match(zip['README.md'], /人工补充/); assert(!JSON.stringify(zip).includes('材料原始内容'));
    assert.throws(() => wb.saveDraftSupplement(d.id, 'late', ''), /已提交/);
    await bob.store.init(); await bob.configureWorkspace(profile('bob'), 'member-password', root, async () => false);
    assert((await bob.remote.list(bob.remote.binding(p.id), p.uploadPath + '/findings')).some(x => x.path === transfer.target));
    const shared = await bob.remote.contentList(bob.remote.binding(p.id)); assert.deepEqual(new Set(shared.filter(x => x.kind === 'contribution').map(x => x.category)), new Set(['finding', 'issue']));
    const next = await wb.prepare(s.id); await until(() => next.generation === 'ready'); assert.notEqual(next.id, d.id);
    await admin.operation({ op: 'group_member', username: 'alice', group: 'local_prepare', role: 'remove', handoffs: { local_prepare: 'bob' } });
    const denied = await wb.submitDraft(next.id); await until(() => denied.status === 'error'); assert.match(denied.error!, /不属于/);
    const original = await diskPath(share, transfer.target); assert((await fs.stat(original)).size > 0);
  } finally { await Promise.all([wb.close(), bob.close()]); admin.disconnect(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-prepare-local-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('SFTP candidate discovery skips other-member submissions and trajectories; denied directory write remains denied', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prepare-sftp-')), server = await teamServer();
  const wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init(); await wb.configureWorkspace(server.profile('alice'), 'test-password', root, async () => true);
    const p = await wb.createProject('分类识别'), b = wb.remote.binding(p.id);
    server.nodes.set(p.remoteRoot + '/资料', { mode: 0o40550, uid: 0, gid: 100, data: Buffer.alloc(0) });
    server.nodes.set(p.remoteRoot + '/submissions/bob', { mode: 0o40750, uid: 1002, gid: 100, data: Buffer.alloc(0) });
    const found = await discoverDestinations(wb.remote, b, () => true);
    assert(found.destinations.some(x => x.path.endsWith('/资料'))); assert(!found.destinations.some(x => x.path.endsWith('/bob') || x.path.includes('trajectories')));
    const file = path.join(root, 'notes.txt'); await fs.writeFile(file, 'notes');
    await wb.configureWorkspace(server.profile('bob'), 'test-password', root, async () => true);
    const transfer = await wb.queue.enqueue(file, wb.remote.binding(p.id), p.remoteRoot + '/资料', 'upload'); await until(() => transfer.status === 'error'); assert.match(transfer.error!, /只能修改自己的提交/);
    wb.remote.disconnect(); const offline = await discoverDestinations(wb.remote, b, () => true); assert.equal(offline.destinations.length, 1); assert(offline.note);
  } finally { await wb.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('hung preparation times out visibly; no duplicate jobs, no automatic upload, supplement survives retry and restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prepare-timeout-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'hang' });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {}, 3000);
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.cursor = fixture.launcher;
    const s = await wb.createSession('cursor', root, offlineProjectId), d = await wb.prepare(s.id);
    await wb.saveDraftSupplement(d.id, '一直保留的补充', ''); await until(() => d.generation === 'error'); assert.match(d.generationError!, /超时/);
    assert(wb.session(d.prepareSessionId!).closedAt); assert.equal(s.status, 'idle'); assert.equal(wb.store.transfers.length, 0);
    await fixture.write({ status: 'ready', turn: 'success', preparationRaw: 'broken response' });
    await wb.retryPreparation(d.id); await until(() => d.generation === 'error'); assert.match(d.generationError!, /格式不完整/);
    await fixture.write({ status: 'ready', turn: 'success' }); await wb.retryPreparation(d.id); await until(() => d.generation === 'ready'); assert.equal(d.supplement, '一直保留的补充');
    await wb.store.save(); const reopened = new Store(wb.store.root); await reopened.init(); assert.equal(reopened.drafts[0].supplement, d.supplement); assert.equal(reopened.drafts[0].body, d.body);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('cancel preparation preserves notes and supplements, stops only the helper, and supports retry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prepare-cancel-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'hang' });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const parent = await wb.createSession('codex', root, offlineProjectId);
    await wb.saveHandoff(parent.id, '# Agent 工作记录\n已有方向性结论');
    await wb.send(parent.id, '持续运行的独立工作');
    await until(() => parent.status === 'running');
    const d = await wb.prepare(parent.id);
    await until(() => wb.session(d.prepareSessionId!).status === 'running');
    await wb.saveDraftSupplement(d.id, '取消后仍保留的补充', '');
    const originalInput = d.inputDir;
    await wb.cancelPreparation(d.id);
    assert.equal(d.generation, 'canceled'); assert(d.generationFinishedAt);
    const helper = wb.session(d.prepareSessionId!);
    assert(helper.closedAt); assert.equal(helper.status, 'idle'); assert.deepEqual(helper.approvals, []);
    assert.equal(parent.status, 'running'); assert.equal(parent.closedAt, undefined);
    assert.equal(await wb.readHandoff(parent.id), '# 阶段摘要\n\n已有方向性结论');
    assert.equal(d.supplement, '取消后仍保留的补充'); assert.equal(wb.store.transfers.length, 0);
    assert.equal((await wb.prepare(parent.id)).id, d.id); assert.equal(d.generation, 'canceled');
    await fixture.write({ status: 'ready', turn: 'success' });
    await wb.retryPreparation(d.id); await until(() => d.generation === 'ready');
    assert.equal(d.inputDir, originalInput); assert.equal(d.supplement, '取消后仍保留的补充');
    const body = d.body;
    await wb.cancelPreparation(d.id); assert.equal(d.generation, 'ready'); assert.equal(d.body, body);
    assert.equal(wb.store.transfers.length, 0);
    await wb.store.save(); const reopened = new Store(wb.store.root); await reopened.init();
    assert.equal(reopened.drafts[0].body, body); assert.equal(reopened.drafts[0].supplement, d.supplement);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('older drafts preserve the reviewed explanation and completed submissions during migration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prepare-migration-'));
  try {
    await fs.writeFile(path.join(root, 'drafts.json'), JSON.stringify([{ id: 'edited', body: 'user edited body', generatedBody: 'old AI body', binding, target: '/p/old', generation: 'ready' }, { id: 'submitted', body: 'frozen body', target: '/p/old', submitted: 'transfer', generation: 'ready' }]));
    const store = new Store(root); await store.init(); assert.equal(store.drafts[0].body, 'user edited body'); assert.equal(store.drafts[0].target, binding.project.uploadPath); assert.equal(store.drafts[1].target, '/p/old');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
