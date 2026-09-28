import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSession, ProjectConclusion, RemoteBinding, SourceFile } from '../src/shared/types';
import type { SharedContent } from '../src/shared/content';
import { accountIdentity } from '../src/shared/account-data';
import { isLegacyTeamResultSource, isRemovableSessionReference, sessionWithAvailableReferences } from '../src/shared/session-result-references';
import { reconcileTeamResultReferences } from '../src/core/session-result-references';
import { Workbench } from '../src/core/workbench';
import { freezeFile } from '../src/core/artifacts';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Protocol fixture, no desktop or real model request.
import { authLauncher } from './fixtures/auth-launcher.mjs';

const binding: RemoteBinding = { connectionId: 'c', host: 'local', port: 22, username: 'alice', fingerprint: 'f', project: { id: 'p', name: '项目', remoteRoot: '/projects/P', uploadPath: '/projects/P/submissions/alice', historyPath: '/projects/P/trajectories/alice' } };
const source = (id: string, sourcePath = `/projects/P/submissions/alice/${id}.zip`): SourceFile => ({ id, name: '旧成果 · v1', localPath: '/frozen/' + id + '.md', sourcePath, sha256: id, size: 1, fetchedAt: '' });
const session = (...sources: SourceFile[]): AgentSession => ({ id: 's', binding, purpose: 'work', provider: 'codex', title: '会话', cwd: '', createdAt: '', status: 'idle', handoffPath: '', messages: [], approvals: [], sources, autoUpload: false });
const conclusion = (id: string, extra = {}): ProjectConclusion => ({ id, projectId: 'p', title: '旧成果', content: '正文', version: 1, updatedAt: '', sources: [], accountOwner: accountIdentity(binding), ...extra });
const visible = (s: AgentSession, items: ProjectConclusion[] = []) => sessionWithAvailableReferences(s, items).sources.map(item => item.id);
const until = async (fn: () => boolean) => { const end = Date.now() + 15000; while (!fn()) { if (Date.now() > end) throw new Error('reference test timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };

test('deleted personal references leave pending choices, while archived results, accepted history and protected context survive', () => {
  const removed = source('removed', 'local-conclusion:gone:v1'), archived = source('archived', 'local-conclusion:archive:v1');
  const unknown = source('unknown', 'C:/files/user.md'), sent = source('sent', 'local-conclusion:gone:v1');
  const brief = source('brief'), assignment = source('task'), inherited = source('fork');
  const s = session(removed, archived, unknown, sent, brief, assignment, inherited);
  s.messages = [{ id: 'message', role: 'user', text: '原始历史', createdAt: '', context: { accepted: true, nativeId: 'old-native', workRecord: false, sourceHashes: { sent: sent.sha256 } } }];
  s.projectBrief = { sourceId: brief.id, revision: 1, capturedAt: '' };
  s.assignment = { id: 'task', revision: 1, title: '任务', sourceIds: [assignment.id] };
  s.fork = { parentId: 'parent', sourceId: inherited.id, inheritedSourceIds: [], capturedAt: '', parentMessageCount: 0, snapshotHash: '', workspaceKind: 'directory-copy', workspaceRoot: '' };
  for (const item of [brief, assignment, inherited]) item.resultUnavailable = true;
  const before = structuredClone(s), items = [conclusion('gone', { deletedAt: 'today' }), conclusion('archive', { archived: true })];
  assert.deepEqual(visible(s, items), ['archived', 'unknown', 'sent', 'brief', 'task', 'fork']);
  assert.deepEqual(s, before, 'filtering must not rewrite source snapshots or history');
  assert.deepEqual(visible(session(removed), [conclusion('gone', { projectId: 'other' })]), []);
  assert.deepEqual(visible(session(removed), [conclusion('gone', { accountOwner: 'another-account' })]), []);
  assert.deepEqual(visible(session(removed), []), [], 'references to missing personal results are hidden too');
});

test('legacy references are reconciled by exact origin, not title, and only complete team scans prove absence', () => {
  const old = source('old'), s = session(old), other = session(source('other'));
  other.binding = { ...binding, username: 'bob' };
  assert(isLegacyTeamResultSource(s, old));
  assert(isRemovableSessionReference(s, old));
  assert(isLegacyTeamResultSource(s, { ...old, sourcePath: '/projects/P/submissions/alice/result.md' }), 'older direct text results need the same treatment as packages');
  assert(!isLegacyTeamResultSource(s, { ...old, name: 'result.md', sourcePath: '/projects/P/submissions/alice/result.md' }), 'a plain file attachment is not a generated result snapshot');
  assert(!isLegacyTeamResultSource(s, { ...old, sourcePath: '/projects/Else/submissions/alice/old.zip' }));
  assert(!isLegacyTeamResultSource(s, { ...old, sourcePath: '/projects/P/submissions/../private.zip' }));
  assert(!isLegacyTeamResultSource(s, { ...old, sourcePath: '/projects/P/项目说明.md' }));
  assert(!reconcileTeamResultReferences([s], binding, [], false));
  assert.deepEqual(visible(s), ['old']);
  const unrelated = { id: 'new-id', revision: 2, path: '/projects/P/submissions/alice/new.zip', title: old.name } as SharedContent;
  assert(reconcileTeamResultReferences([s, other], binding, [unrelated], true));
  assert.deepEqual(visible(s), []); assert(!other.sources[0].resultUnavailable);
  assert.equal(old.contentRef, undefined, 'a similar title cannot attach the wrong result');
  const archived = { ...unrelated, id: 'old-id', path: old.sourcePath, supersededBy: { scope: 'team', projectId: 'p', id: unrelated.id, version: 2 } } as SharedContent;
  assert(reconcileTeamResultReferences([s], binding, [unrelated, archived], true));
  assert.deepEqual(visible(s), ['old'], 'history entries still count as retained results');
  assert.deepEqual(old.contentRef, { projectId: 'p', id: 'old-id', revision: 1 }, 'the frozen version must not become the current revision');
  assert(!reconcileTeamResultReferences([s], binding, [], false), 'an incomplete later scan does not erase known references');
  assert(reconcileTeamResultReferences([s], binding, [{ ...archived, deletedAt: 'today' }], true));
  assert.deepEqual(visible(s), [], 'a deletion tombstone in history is not a retained result');
  assert(reconcileTeamResultReferences([s], binding, [archived], true));
  assert(reconcileTeamResultReferences([s], binding, [], false, [archived]));
  assert.deepEqual(visible(s), []);
});

test('legacy references can be retracted including duplicate IDs; protected aliases and accepted history cannot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-legacy-references-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const s = await wb.createSession('codex', root, offlineProjectId), file = path.join(root, 'reference.md'); await fs.writeFile(file, '旧成果正文');
    const old = await freezeFile(file, path.join(wb.store.sessionDir(s.id), 'sources'));
    old.name = '旧成果 · v1'; old.sourcePath = s.binding!.project.uploadPath + '/old.zip';
    const duplicate = { ...old, id: randomUUID() }; s.sources.push(old, duplicate);
    await wb.saveInput(s.id, { text: '继续', sourceIds: [old.id, duplicate.id], answers: {} });
    assert(isRemovableSessionReference(s, old));
    s.projectBrief = { sourceId: duplicate.id, revision: 1, capturedAt: '' };
    assert(!isRemovableSessionReference(s, old));
    await assert.rejects(wb.detachPendingSource(s.id, old.id), /项目说明/);
    delete s.projectBrief;
    s.messages.push({ id: randomUUID(), role: 'user', text: '已经发送', createdAt: '', context: { nativeId: 'old-native', accepted: true, workRecord: false, sourceHashes: { [duplicate.id]: duplicate.sha256 } } });
    await assert.rejects(wb.detachPendingSource(s.id, old.id), /已发送给模型/);
    s.messages = [];
    assert.deepEqual((await wb.detachPendingSource(s.id, old.id)).sourceIds, [old.id, duplicate.id]);
    assert.equal(s.sources.length, 0); assert.deepEqual(wb.store.inputs[s.id].sourceIds, []);
    assert.equal(await fs.readFile(file, 'utf8'), '旧成果正文', 'the original file is not deleted');
  } finally { await wb.close(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-legacy-references-'))); await fs.rm(root, { recursive: true, force: true }); }
});

test('personal deletion filters UI, stale selections, automatic send context and restored data, with rollback on save failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-deleted-references-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  const cli = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success' });
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = cli.launcher;
    const s = await wb.createSession('codex', root, offlineProjectId), item = await wb.createConclusion(offlineProjectId, '未发送成果', '不再需要');
    const ref = await wb.attachConclusion(s.id, item.id);
    await wb.saveInput(s.id, { text: '继续工作', sourceIds: [ref.id], answers: {} });
    const save = wb.store.save.bind(wb.store); wb.store.save = () => Promise.reject(new Error('disk failure'));
    await assert.rejects(wb.deleteConclusion(item.id, item.version), /disk failure/); wb.store.save = save;
    assert(wb.snapshot().sessions.find(value => value.id === s.id)!.sources.some(value => value.id === ref.id));
    await wb.deleteConclusion(item.id, item.version);
    assert.equal(wb.conclusions(offlineProjectId).length, 0);
    assert(!wb.snapshot().sessions.find(value => value.id === s.id)!.sources.some(value => value.id === ref.id));
    assert.deepEqual(wb.snapshot().inputs[s.id].sourceIds, []);
    await wb.saveInput(s.id, { text: '继续工作', sourceIds: [ref.id], answers: {} });
    assert.deepEqual(wb.store.inputs[s.id].sourceIds, []);
    await wb.send(s.id, '继续工作', [ref.id]); await until(() => s.status !== 'running' && s.status !== 'starting');
    const sent = s.messages.find(message => message.role === 'user')!;
    assert(!sent.text.includes(ref.localPath)); assert(!sent.context?.sourceHashes[ref.id]);
    assert(await fs.stat(ref.localPath), 'the frozen copy remains available for audit/history');
    const restored = new Workbench(wb.store.root, () => {}, () => {}); await restored.store.init();
    assert(!restored.snapshot().sessions.find(value => value.id === s.id)!.sources.some(value => value.id === ref.id));
    await restored.close();
    const racing = await wb.createConclusion(offlineProjectId, '发送中删除', '不能泄露进本轮');
    const pending = await wb.attachConclusion(s.id, racing.id), runtime = (wb as any).runtimes.get(s.id);
    const resolve = runtime.resolveCapabilities.bind(runtime);
    runtime.resolveCapabilities = async (...args: unknown[]) => { await wb.deleteConclusion(racing.id, racing.version); return resolve(...args); };
    const before = s.messages.filter(message => message.role === 'user').length;
    await assert.rejects(wb.send(s.id, '不应发送', [pending.id]), /参考成果已删除/);
    assert.equal(s.messages.filter(message => message.role === 'user').length, before);
    runtime.resolveCapabilities = resolve;
  } finally { await wb.close(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-deleted-references-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
