import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { Store, atomicJson } from '../src/core/store';
import { recoverPersonalMove } from '../src/core/personal-move';
import { journalDirectory } from '../src/core/project-journal';
import { accountIdentity } from '../src/shared/account-data';
import { sessionMoveFamilyIds } from '../src/shared/subsessions';
import { changeQuestion, type TeamQuestion } from '../src/shared/questions';
import type { AgentSession, Draft } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId as sourceId } from './fixtures/offline-workspace';

const targetId = 'project_' + 'b'.repeat(32);
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-session-move-'));
  const wb = new Workbench(root, () => {}, () => {}); await wb.store.init(); grantTestWorkspace(wb, root);
  const source = wb.store.settings.workspaceSnapshot!.profile.projects[0];
  wb.store.settings.workspaceSnapshot!.profile.projects.push({ ...source, id: targetId, name: '目标项目', remoteRoot: '/projects/target', uploadPath: '/projects/target/submissions/alice', historyPath: '/projects/target/trajectories/alice' });
  const create = (projectId = sourceId) => wb.createSession('codex', root, projectId, 'work', undefined, undefined, 'inherit', false, 'direct');
  return { root, wb, create, close: async () => { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); } };
}
function fork(parent: AgentSession, child: AgentSession, promoted = false) {
  child.parentId = promoted ? undefined : parent.id;
  child.fork = { parentId: parent.id, capturedAt: parent.createdAt, parentMessageCount: 0, snapshotHash: 'frozen', sourceId: 'snapshot', inheritedSourceIds: [], workspaceKind: 'shared-directory', workspaceRoot: parent.cwd, ...(promoted ? { promotedAt: parent.createdAt } : {}) };
}
function accept(s: AgentSession, journal: NonNullable<Awaited<ReturnType<Workbench['journal']['context']>>>) {
  s.messages.push({ id: randomUUID(), role: 'user', text: '继续', createdAt: new Date().toISOString(), context: { nativeId: s.nativeId!, accepted: true, sourceHashes: {}, workRecord: true, projectJournal: journal.receipt } });
}

test('project sessions move offline as a whole family and retain history, input, native identity, summaries and five-entry logs', async () => {
  const f = await fixture();
  try {
    const parent = await f.create(), child = await f.create(), grandchild = await f.create(), promoted = await f.create(), stay = await f.create(), target = await f.create(targetId);
    fork(parent, child); fork(child, grandchild); fork(parent, promoted, true);
    const prepare = { ...structuredClone(child), id: randomUUID(), purpose: 'prepare' as const, parentId: child.id, fork: undefined }; f.wb.store.sessions.push(prepare);
    parent.nativeId = randomUUID(); parent.nativePath = path.join(f.root, 'external-native.jsonl');
    await fs.writeFile(parent.nativePath, 'original native history');
    parent.messages.push({ id: randomUUID(), role: 'assistant', text: '历史结论', createdAt: parent.createdAt });
    parent.projectBrief = { revision: 1, sourceId: 'old-brief', capturedAt: parent.createdAt };
    parent.assignment = { id: 'old-task', revision: 1, title: '原任务', sourceIds: [] }; parent.autoUpload = true;
    f.wb.store.inputs[parent.id] = { text: '还没有发送的内容', sourceIds: [], answers: {} };
    for (let i = 0; i < 7; i++) {
      const old = await fs.readFile(parent.handoffPath, 'utf8');
      assert(await f.wb.journal.commit(parent, createHash('sha256').update(old).digest('hex'), i + 1, '当前阶段摘要', { turnId: 'turn-' + i, at: parent.createdAt, text: '完成工作 ' + i }));
    }
    await f.wb.journal.project(stay); await f.wb.journal.project(target);
    const ids = sessionMoveFamilyIds(f.wb.store.sessions, [grandchild.id]);
    assert.deepEqual(ids, new Set([parent.id, child.id, grandchild.id, prepare.id]));
    const result = await f.wb.moveWithinLocal(targetId, { sessionId: grandchild.id });
    assert.equal(result.count, 3); assert.equal(f.wb.remote.connected, false);
    for (const id of ids) assert.equal(f.wb.session(id).binding!.project.id, targetId);
    for (const session of [stay, promoted]) assert.equal(f.wb.session(session.id).binding!.project.id, sourceId);
    const moved = f.wb.session(parent.id);
    assert.equal(moved.nativeId, parent.nativeId); assert.equal(moved.cwd, parent.cwd); assert.equal(moved.handoffPath, parent.handoffPath);
    assert.deepEqual(moved.messages, parent.messages); assert.equal(await fs.readFile(parent.nativePath, 'utf8'), 'original native history');
    assert.equal(moved.assignment, undefined); assert.equal(moved.projectBrief, undefined); assert.equal(moved.autoUpload, false);
    assert.equal(f.wb.store.inputs[parent.id].text, '还没有发送的内容');
    const record = (await f.wb.journal.exportSessions(new Set([parent.id])))[0];
    assert.equal(record.projectId, targetId); assert.deepEqual(record.entries.map(item => item.turnId), ['turn-2', 'turn-3', 'turn-4', 'turn-5', 'turn-6']);
    assert.equal(await fs.readFile(moved.handoffPath, 'utf8'), '当前阶段摘要');
    assert(!(await f.wb.journal.project(stay)).text.includes(parent.id));
    assert((await f.wb.journal.project(target)).text.includes(parent.id));
    await assert.rejects(fs.access(path.join(journalDirectory(stay), parent.id + '.md')));
    assert.match((await f.wb.journal.context(moved))!.text, /会话已迁移到此项目/);
    await assert.rejects(f.wb.moveWithinLocal(targetId, { sessionId: parent.id }), /已在目标项目/);
  } finally { await f.close(); }
});

test('busy descendants, side chats, uploads, foreign owners and mixed families reject without changing ownership', async () => {
  const f = await fixture();
  try {
    const parent = await f.create(), child = await f.create(); fork(parent, child);
    const rejected = async () => { await assert.rejects(f.wb.moveWithinLocal(targetId, { sessionId: parent.id })); assert.equal(parent.binding!.project.id, sourceId); assert.equal(child.binding!.project.id, sourceId); };
    child.status = 'running'; await rejected(); child.status = 'idle';
    child.cursorPendingSubmission = { id: randomUUID(), text: '等待确认的输入' }; await rejected(); delete child.cursorPendingSubmission;
    (f.wb as any).stoppingSessions.add(child.id); await rejected(); (f.wb as any).stoppingSessions.delete(child.id);
    (f.wb as any).sideChats.set('side', { view: { parentId: child.id, session: { status: 'running' } }, busy: true }); await rejected(); (f.wb as any).sideChats.clear();
    f.wb.store.transfers.push({ sessionId: child.id, status: 'queued' } as any); await rejected(); f.wb.store.transfers = [];
    child.binding = { ...child.binding!, username: 'other' }; await rejected(); child.binding.username = 'alice';
    child.binding.project = { ...child.binding.project, id: targetId };
    await assert.rejects(f.wb.moveWithinLocal(targetId, { sessionId: parent.id }), /归属不一致/);
    child.binding.project.id = sourceId;
    await assert.rejects(f.wb.moveWithinLocal('missing', { sessionId: parent.id }), /本机没有此项目/);
    assert.equal((await f.wb.moveWithinLocal(targetId, { sessionId: parent.id })).count, 2);
  } finally { await f.close(); }
});

test('published results stay in the old project while drafts and local references follow the session', async () => {
  const f = await fixture();
  try {
    const session = await f.create(), result = await f.wb.createConclusion(sourceId, '已发布成果', '成果正文');
    result.publication = { version: 1, files: '[]', path: '/old/published.md', sha256: 'hash', at: session.createdAt };
    await f.wb.attachConclusion(session.id, result.id);
    const draft = { id: randomUUID(), sessionId: session.id, generation: 'ready', title: '未提交草稿', body: '草稿正文', files: [], binding: session.binding, inputDir: f.root, outputPath: path.join(f.root, 'draft.md'), createdAt: session.createdAt, personalSavedIds: [result.id], artifacts: [{ id: randomUUID(), category: 'method_exploration', title: '条目', fields: {}, body: '正文', selected: true, target: '/old', updateTarget: { id: 'old-result', version: 1, projectId: sourceId, scope: 'team' } }] } as Draft;
    f.wb.store.drafts.push(draft);
    draft.conclusionMergeProjectId = sourceId;
    draft.mergeSources = [{ id: result.id, revision: result.version, title: result.title, author: 'alice', updatedAt: result.updatedAt }];
    draft.mergeReplacementIds = [result.id];
    await f.wb.moveWithinLocal(targetId, { sessionId: session.id });
    assert.equal(f.wb.conclusions(sourceId)[0].id, result.id); assert.equal(f.wb.conclusions(sourceId)[0].publication!.path, '/old/published.md');
    const copy = f.wb.conclusions(targetId)[0]; assert.notEqual(copy.id, result.id); assert.equal(copy.publication, undefined);
    assert(f.wb.session(session.id).sources.some(source => source.sourcePath.startsWith('local-conclusion:' + copy.id + ':')));
    const movedDraft = f.wb.store.drafts.find(item => item.id === draft.id)!;
    assert.deepEqual(movedDraft.personalSavedIds, [copy.id]); assert.equal(movedDraft.binding!.project.id, targetId); assert.equal(movedDraft.artifacts![0].updateTarget, undefined);
    assert.equal(movedDraft.conclusionMergeProjectId, targetId); assert.equal(movedDraft.mergeSources![0].id, copy.id); assert.deepEqual(movedDraft.mergeReplacementIds, [copy.id]);
  } finally { await f.close(); }
});

test('A to B to A always supplies a full project journal once after each move', async () => {
  const f = await fixture();
  try {
    let session = await f.create(); session.nativeId = randomUUID();
    accept(session, (await f.wb.journal.context(session))!);
    await f.wb.moveWithinLocal(targetId, { sessionId: session.id }); session = f.wb.session(session.id);
    const second = (await f.wb.journal.context(session))!; assert.match(second.text, /首次全量/); accept(session, second);
    assert.equal(await f.wb.journal.context(session), undefined);
    await f.wb.moveWithinLocal(sourceId, { sessionId: session.id }); session = f.wb.session(session.id);
    const third = (await f.wb.journal.context(session))!; assert.match(third.text, /首次全量/); assert.match(third.text, /会话已迁移/); accept(session, third);
    assert.equal(await f.wb.journal.context(session), undefined);
  } finally { await f.close(); }
});

test('migration detaches old question automation and recommendations without closing the question', async () => {
  const f = await fixture();
  try {
    const session = await f.create(), owner = accountIdentity(session.binding!);
    const members = [{ username: 'alice', name: 'Alice' }, { username: 'bob', name: 'Bob' }], items: TeamQuestion[] = [];
    const q = changeQuestion(items, sourceId, members[1], members, { kind: 'create', id: randomUUID(), sessionId: randomUUID(), title: '旧项目问题', body: '请补充', context: '', recipients: ['alice'] }, session.createdAt);
    changeQuestion(items, sourceId, members[0], members, { kind: 'link', id: q.id, sessionId: session.id }, session.createdAt);
    const jobs = [{ questionId: q.id, projectId: sourceId, sessionId: session.id, runId: randomUUID(), phase: 'queued', mode: 'answer' }];
    await atomicJson(path.join(f.root, 'questions.json'), { [owner]: { items, jobs, read: {}, notified: {}, replyModes: { [q.id]: 'auto' }, dialogues: [{ questionId: q.id, projectId: sourceId, peer: 'bob', sessionId: session.id, mode: 'auto' }] } });
    await f.wb.questions.init();
    f.wb.store.activity.jobs.push({ id: randomUUID(), owner, sessionId: session.id, attempts: 0, status: 'matched', event: { projectId: sourceId } } as any);
    await f.wb.moveWithinLocal(targetId, { sessionId: session.id });
    const inbox = f.wb.questions.view(); assert.equal(inbox.jobs[0].phase, 'closed'); assert.equal(inbox.replyModes![q.id], 'manual'); assert.deepEqual(inbox.dialogues, []);
    assert.equal(inbox.items[0].closedAt, undefined); assert.equal(f.wb.questions.lockedPeer(session.id), undefined);
    assert.equal(f.wb.store.activity.jobs[0].status, 'obsolete');
    const moved = f.wb.session(session.id); moved.messages.push({ id: randomUUID(), role: 'assistant', text: '新项目回答', createdAt: session.createdAt });
    await f.wb.questions.completed(moved); assert.equal(inbox.fills?.[q.id], undefined);
    await f.wb.questions.sync(); assert.equal(inbox.jobs.length, 1); assert.equal(f.wb.remote.connected, false);
  } finally { await f.close(); }
});

test('failed same-account persistence recovers idempotently with session IDs and inputs intact', async () => {
  const f = await fixture();
  try {
    const session = await f.create(); f.wb.store.inputs[session.id] = { text: '输入草稿', sourceIds: [], answers: {} }; await f.wb.store.save();
    const save = f.wb.store.save.bind(f.wb.store);
    f.wb.store.save = async () => { throw new Error('disk unavailable'); };
    await assert.rejects(f.wb.moveWithinLocal(targetId, { sessionId: session.id }), /迁移记录已保留/);
    await assert.rejects(f.wb.moveWithinLocal(sourceId, { sessionId: session.id }), /重启/);
    f.wb.store.save = save;
    await recoverPersonalMove(f.root); await recoverPersonalMove(f.root);
    const restored = new Store(f.root); await restored.init();
    assert.equal(restored.sessions.filter(item => item.id === session.id).length, 1); assert.equal(restored.sessions[0].binding!.project.id, targetId);
    assert.equal(restored.inputs[session.id].text, '输入草稿');
    await assert.rejects(fs.access(path.join(f.root, 'pending-personal-move.json')));
  } finally { await f.close(); }
});
