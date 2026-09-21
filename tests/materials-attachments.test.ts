import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { Workbench } from '../src/core/workbench';
import { memberProfile } from './fixtures/member-profile';
import { applyPreparation } from '../src/core/preparation';
import { diskPath } from '../src/core/local-space';
import { mergeAccountRecords } from '../src/core/account-sync';
import type { Draft } from '../src/shared/types';

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-materials-')), shared = path.join(root, 'shared'); await fs.mkdir(shared);
  const admin = new LocalAdminConnection(() => {});
  await admin.connect({ mode: 'local', localRoot: shared, host: 'local', port: 22, username: 'admin', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
  await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: 'research' });
  for (const username of ['alice', 'bob']) await admin.operation({ op: 'user_create', username, name: username, password: '1', groups: ['local_research'], contentAdminGroups: ['local_research'] });
  const clients: Workbench[] = [];
  const client = async (slot: string, username = 'alice') => {
    const wb = new Workbench(path.join(root, slot), () => {}, () => {}); clients.push(wb); await wb.store.init();
    const profile = memberProfile(admin.snapshot.profile!, admin.snapshot.state!, username); profile.id = 'connection-' + slot;
    await wb.configureWorkspace(profile, '1', '', async () => false); return wb;
  };
  const first = await client('one'), project = await first.createProject('调研项目', 'local_research');
  return { root, shared, admin, first, project, client, close: async () => { await Promise.all(clients.map(wb => wb.close())); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
async function settled(wb: Workbench) { const deadline = Date.now() + 15000; while (wb.store.transfers.some(item => ['running', 'queued'].includes(item.status))) { if (Date.now() > deadline) throw Error('queue timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } }

test('research folders persist; account restores personal materials and selected files, never sessions or code paths', async () => {
  const env = await setup();
  try {
    const { first: a, project, root } = env;
    const session = await a.createSession('codex', '', project.id), second = await a.createSession('codex', '', project.id);
    assert.notEqual(session.cwd, second.cwd); assert(session.cwd.startsWith(path.join(a.store.root, 'workspaces')));
    session.messages.push({ id: randomUUID(), role: 'user', text: 'PRIVATE_FULL_CONVERSATION', createdAt: new Date().toISOString() });
    const material = await a.createConclusion(project.id, '【项目标准】 使用人工复核结果验收', '必须保留独立复核。');
    const draft: Draft = { id: randomUUID(), sessionId: session.id, binding: session.binding, title: '资料', body: '', files: [], inputDir: path.join(a.store.root, 'drafts', 'input'), outputPath: path.join(a.store.root, 'drafts', 'result.md'), createdAt: new Date().toISOString(), generation: 'ready', preparationVersion: 3, concise: true };
    applyPreparation(draft, JSON.stringify({ artifacts: [{ category: 'finding', title: '抽样复核能发现漏检', fields: { statement: '复核发现了漏检。' } }] })); a.store.drafts.push(draft);
    const file = path.join(root, '证据.csv'); await fs.writeFile(file, 'item,result\n1,pass'); await a.addDraftFiles(draft.id, [file], draft.artifacts![0].id);
    await a.accountSync.sync(); assert.equal(a.accountSync.state.status, 'synced', a.accountSync.state.detail || '');
    const remote = await a.remote.accountData(); assert(!JSON.stringify(remote).includes('PRIVATE_FULL_CONVERSATION')); assert(!JSON.stringify(remote).includes(session.cwd));
    const b = await env.client('two'); assert.equal(b.store.sessions.length, 0); assert.equal(b.conclusions(project.id)[0].id, material.id);
    assert.equal(await fs.readFile(b.store.drafts[0].files[0].localPath, 'utf8'), 'item,result\n1,pass');
    assert.equal((await env.client('other', 'bob')).conclusions(project.id).length, 0);
    await a.saveConclusion(material.id, material.title, '电脑一编辑'); await a.accountSync.sync();
    await b.saveConclusion(material.id, material.title, '电脑二编辑'); await b.accountSync.sync();
    assert.equal(b.accountSync.state.status, 'conflict'); assert.equal(b.conclusions(project.id)[0].content, '电脑二编辑');
    await b.accountSync.resolve('material:' + material.id, 'local'); assert.equal(b.accountSync.state.status, 'synced');
    await a.accountSync.sync(); assert.equal(a.conclusions(project.id)[0].content, '电脑二编辑');
    assert.equal(a.store.sessions.length, 2); assert.equal(a.session(session.id).cwd, session.cwd);
  } finally { await env.close(); }
});

test('attachments are explicit, frozen, deduplicated, dependency-gated and retryable without duplicating successful files', async () => {
  const env = await setup();
  try {
    const wb = env.first, session = await wb.createSession('codex', '', env.project.id);
    const draft: Draft = { id: randomUUID(), sessionId: session.id, binding: session.binding, title: '', body: '', files: [], inputDir: path.join(wb.store.root, 'input'), outputPath: path.join(wb.store.root, 'draft.md'), createdAt: new Date().toISOString(), generation: 'ready', preparationVersion: 3 };
    applyPreparation(draft, JSON.stringify({ artifacts: [{ category: 'finding', title: '结果', fields: { statement: '实际结果' }, attachmentIds: ['invented'] }, { category: 'issue', title: '风险', fields: { problem: '边界缺口' } }] }));
    assert.deepEqual(draft.artifacts![0].attachments, []); wb.store.drafts.push(draft);
    const file = path.join(env.root, 'report.csv'); await fs.writeFile(file, 'frozen evidence');
    await wb.addDraftFiles(draft.id, [file], draft.artifacts![0].id); await wb.addDraftFiles(draft.id, [file], draft.artifacts![1].id);
    await fs.writeFile(file, 'changed after selection');
    const upload = wb.remote.uploadAttachment.bind(wb.remote); let failures = 1, successful = 0;
    wb.remote.uploadAttachment = async (...args) => { if (failures-- > 0) throw new Error('temporary failure'); successful++; return upload(...args); };
    const transfer = await wb.submitDraft(draft.id); await settled(wb);
    assert.equal(wb.store.transfers.filter(item => item.attachment).length, 1); assert.equal(transfer.status, 'error'); assert.equal((await wb.remote.contentList(session.binding!)).length, 0);
    await wb.queue.retry(transfer.id); await settled(wb);
    assert(wb.store.transfers.every(item => item.status === 'done'), JSON.stringify(wb.store.transfers.map(item => item.error))); assert.equal(successful, 1);
    const shared = await wb.remote.contentList(session.binding!); assert.equal(shared.length, 2); assert.equal(shared[0].attachments![0].path, shared[1].attachments![0].path);
    assert.equal(await fs.readFile(await diskPath(env.shared, shared[0].attachments![0].path), 'utf8'), 'frozen evidence');
    const combined = await wb.remote.contentEdit(session.binding!, { id: shared[0].id, revision: 1, action: 'save', title: '合并结果', description: '保留证据', curate: true, merge: [{ id: shared[1].id, revision: 1 }] });
    assert.equal(combined!.attachments!.length, 1);
    await assert.rejects(wb.addDraftFiles(draft.id, [file], draft.artifacts![0].id), /提交前/);
  } finally { await env.close(); }
});

test('empty concise result is success; cap, valid categories and read/archive merge are enforced', () => {
  const draft = { id: 'd', concise: true, files: [], binding: { project: { remoteRoot: '/p', uploadPath: '/p/submissions/a' } } } as unknown as Draft;
  applyPreparation(draft, '{"artifacts":[]}'); assert.equal(draft.body, ''); assert.equal(draft.artifacts!.length, 0);
  assert.throws(() => applyPreparation(draft, JSON.stringify({ artifacts: Array(4).fill({ category: 'finding', title: '重复', fields: { statement: '重复' } }) })), /超过 3/);
  const result = mergeAccountRecords({ 'update:p': { title: '旧' } }, { 'update:p': { title: '新', readAt: 'now' } }, { 'update:p': { title: '新', actions: [{ kind: 'archived' }] } });
  assert.equal(result.records['update:p'].readAt, 'now'); assert.equal(result.conflicts.length, 0);
});

test('account switching never exports another account and loss of membership keeps private records', async () => {
  const env = await setup();
  try {
    const a = env.first, material = await a.createConclusion(env.project.id, '仅 Alice 的资料', 'PRIVATE_ALICE'); await a.accountSync.sync();
    const login = async (name: string) => a.configureWorkspace(memberProfile(env.admin.snapshot.profile!, env.admin.snapshot.state!, name), '1', '', async () => false);
    await login('bob'); assert.equal(a.conclusions(env.project.id).length, 0);
    await a.createConclusion(env.project.id, '仅 Bob 的资料', 'PRIVATE_BOB'); await a.accountSync.sync();
    assert(!JSON.stringify(await a.remote.accountData()).includes('PRIVATE_ALICE'));
    await login('alice'); assert.equal(a.conclusions(env.project.id)[0].id, material.id);
    assert(!JSON.stringify(await a.remote.accountData()).includes('PRIVATE_BOB'));
    await env.admin.operation({ op: 'group_member', group: 'local_research', username: 'alice', role: 'remove' });
    await a.refreshGroups(); await a.accountSync.sync();
    assert(JSON.stringify(await a.remote.accountData()).includes('PRIVATE_ALICE'));
  } finally { await env.close(); }
});
