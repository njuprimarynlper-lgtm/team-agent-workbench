import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { applyPreparation } from '../src/core/preparation';
import type { ContentUpdate, Draft } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

test('an explicitly removed local conclusion is not recreated from its saved draft on restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-deleted-conclusion-'));
  let wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const session = await wb.createSession('codex', root, offlineProjectId), now = new Date().toISOString();
    const draft: Draft = { title: '', body: '', id: 'deleted-source-draft', sessionId: session.id, binding: session.binding, generation: 'ready', preparationVersion: 3, inputDir: path.join(root, 'input'), outputPath: path.join(root, 'draft.md'), files: [], createdAt: now };
    applyPreparation(draft, JSON.stringify({ artifacts: [{ category: 'finding', title: '曾经保留的内容', fields: { statement: '同一结论同时有本地和远端来源。' } }] }));
    wb.store.drafts.push(draft); await wb.renameDraftResult(draft.id, '曾经保留的内容', draft.artifacts![0].id);
    const item = wb.conclusions(offlineProjectId)[0];
    item.sources.push({ id: 'removed-remote', kind: 'remote', title: '远端来源', updatedAt: now });
    wb.store.settings.contentUpdates = [{ eventId: 'deletion', projectId: offlineProjectId, projectName: '测试项目', id: 'removed-remote', title: '远端来源', revision: 1, change: 'deleted', occurredAt: now, detectedAt: now }];
    const source = await wb.attachConclusion(session.id, item.id);
    await wb.resolveContentDeletion('deletion', [{ id: item.id, version: item.version }]);
    await wb.close();
    wb = new Workbench(path.join(root, 'data'), () => {}, () => {}); wb.detect = async () => []; await wb.init();
    assert.equal(wb.conclusions(offlineProjectId, true).length, 0);
    assert.equal(wb.session(session.id).sources[0].id, source.id);
    assert.equal((await fs.readFile(source.localPath, 'utf8')).includes('同一结论'), true);
    await assert.rejects(wb.archiveConclusion(item.id, false), /不存在/);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('restart preserves sessions, inputs, all unread/history events, dismissed alerts, draft names and archived conclusions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-preserve-'));
  let wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const session = await wb.createSession('codex', root, offlineProjectId);
    const second = await wb.createSession('cursor', root, offlineProjectId), third = await wb.createSession('codex', root, offlineProjectId);
    session.title = '保留的算法会话'; session.nativeId = 'existing-native-session';
    session.messages.push({ id: 'question', role: 'user', text: '尚未完成的问题', createdAt: new Date().toISOString() });
    third.closedAt = new Date().toISOString();
    await wb.saveInput(second.id, { text: '尚未发送的草稿', sourceIds: [], answers: {} });
    const now = new Date().toISOString();
    wb.store.settings.contentUpdates = Array.from({ length: 350 }, (_, n): ContentUpdate => ({ eventId: `event-${n}`, id: `remote-${n}`, projectId: offlineProjectId, projectName: '测试项目', title: `动态 ${n}`, revision: 1, change: 'new', occurredAt: now, detectedAt: now, ...(n % 3 === 0 ? { readAt: now } : {}) }));
    wb.store.settings.contentSeen = { account: { remote: 1 } };
    wb.store.settings.contentAliases = { local: '我的远端别名' };
    wb.store.settings.egress = { enabled: true, host: 'admin.internal', port: 18443, certificateFingerprint: 'AB'.repeat(32) };
    await wb.dismissContentUpdates(['event-1', 'event-2']);
    assert.equal(wb.store.settings.contentUpdates[1].readAt, undefined, 'closing the toast must not mark a pending item read');
    const draft: Draft = { title: '', body: '', id: 'preserved-draft', sessionId: session.id, binding: session.binding, generation: 'ready', preparationVersion: 3, inputDir: path.join(root, 'input'), outputPath: path.join(root, 'draft.md'), files: [], createdAt: now };
    applyPreparation(draft, JSON.stringify({ artifacts: [{ category: 'finding', title: '旧名称', fields: { statement: '待验证的算法结论' } }] }));
    wb.store.drafts.push(draft); await wb.renameDraftResult(draft.id, '用户填写的名称', draft.artifacts![0].id);
    const conclusion = wb.conclusions(offlineProjectId)[0]; await wb.attachConclusion(session.id, conclusion.id);
    await wb.archiveConclusion(conclusion.id, true);
    draft.submitted = draft.artifacts![0].submitted = 'uploaded-package';
    await wb.renameDraftResult(draft.id, '仅本机使用的名称', draft.artifacts![0].id);
    await wb.archiveConclusion(conclusion.id, true);
    const snapshot = JSON.parse(JSON.stringify({ sessions: wb.store.sessions, inputs: wb.store.inputs, drafts: wb.store.drafts, conclusions: wb.store.conclusions, updates: wb.contentUpdates(), dismissed: wb.store.settings.dismissedContentUpdateIds, seen: wb.store.settings.contentSeen, aliases: wb.store.settings.contentAliases }));
    await wb.close();
    wb = new Workbench(path.join(root, 'data'), () => {}, () => {}); wb.detect = async () => [];
    await wb.init();
    assert.deepEqual(wb.store.sessions, snapshot.sessions); assert.deepEqual(wb.store.inputs, snapshot.inputs);
    assert.deepEqual(wb.store.drafts, snapshot.drafts); assert.deepEqual(wb.store.conclusions, snapshot.conclusions);
    assert.deepEqual(wb.contentUpdates(), snapshot.updates); assert.equal(wb.contentUpdates().length, 350);
    assert.deepEqual(wb.store.settings.dismissedContentUpdateIds, snapshot.dismissed);
    assert.deepEqual(wb.store.settings.contentSeen, snapshot.seen); assert.deepEqual(wb.store.settings.contentAliases, snapshot.aliases);
    assert.equal(wb.workspaceReady, true);
    assert.deepEqual(wb.store.settings.egress, { enabled: true, host: 'admin.internal', port: 18443, certificateFingerprint: 'AB'.repeat(32) });
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
