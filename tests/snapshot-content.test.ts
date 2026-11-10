import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession, Snapshot } from '../src/shared/types';
import { compactSnapshotContent, hydrateSnapshotContent, knownSessionContent } from '../src/shared/snapshot-content';
import { snapshotAccountKey } from '../src/shared/account-scope';
import { acceptedSessionContext, sourceWasAccepted } from '../src/shared/session-context';
import { pendingComposerReferences } from '../src/renderer/composer-references';

const session = (): AgentSession => ({ id: '11111111-1111-4111-8111-111111111111', title: '会话', provider: 'codex', purpose: 'work', status: 'idle', createdAt: '2026-01-01T00:00:00.000Z', cwd: '', handoffPath: '', sources: [], approvals: [], autoUpload: false,
  messages: [{ id: 'm1', role: 'assistant', text: '历史消息', createdAt: '2026-01-01T00:00:00.000Z' }] });
const snapshot = (s = session()): Snapshot => ({ settings: { codexRequestGuard: true, connections: [], providerPaths: { codex: '', cursor: '', claude: '' }, lastWorkspace: '', trustedServerIdentities: {}, workspaceSnapshot: { profile: { id: 'test', name: '测试', host: 'example.test', port: 22, username: 'alice', fingerprint: 'test', manifestPath: '/', projects: [] }, workspaces: [] } } as Snapshot['settings'], sessions: [s], inputs: {}, transfers: [], drafts: [], providers: [], auth: {} as Snapshot['auth'], workspaceReady: true });
const key = 'account';

test('unchanged history stays in the renderer while metadata refreshes', () => {
  const before = snapshot();
  const updated = snapshot({ ...before.sessions[0], title: '新标题' });
  const compact = compactSnapshotContent(updated, key, knownSessionContent(before));
  // A mismatched account never omits history.
  assert.equal(compact.sessions[0].messages[0].text, '历史消息');
});

test('incremental snapshot retains history and loads changed messages', () => {
  const before = snapshot();
  const accountKey = snapshotAccountKey(before);
  const updated = snapshot({ ...before.sessions[0], title: '新标题' });
  const compact = compactSnapshotContent(updated, accountKey, knownSessionContent(before));
  assert.equal(compact.sessions[0].messages, undefined);
  const hydrated = hydrateSnapshotContent(compact, before)!;
  assert.equal(hydrated.sessions[0].title, '新标题');
  assert.equal(hydrated.sessions[0].messages, before.sessions[0].messages);

  updated.sessions[0].messages = [...before.sessions[0].messages, { id: 'm2', role: 'assistant', text: '新增', createdAt: before.sessions[0].createdAt }];
  assert.equal(compactSnapshotContent(updated, accountKey, knownSessionContent(before)).sessions[0].messages.length, 2);
  updated.sessions[0].messages = [{ ...before.sessions[0].messages[0], text: '新正文' }];
  updated.sessions[0].storageRevision = 1;
  assert.equal(compactSnapshotContent(updated, accountKey, knownSessionContent(before)).sessions[0].messages[0].text, '新正文');
});

test('missing local history requests a full snapshot', () => {
  const before = snapshot(), compact = compactSnapshotContent(before, snapshotAccountKey(before), knownSessionContent(before));
  assert.equal(hydrateSnapshotContent(compact, snapshot({ ...session(), id: 'other' })), undefined);
});

test('paged snapshot sends only the newest message page and keeps the full count', () => {
  const full = session();
  full.messages = Array.from({ length: 700 }, (_, index) => ({ ...full.messages[0], id: `m${index}`, text: `message ${index}` }));
  const data = snapshot(full);
  const first = compactSnapshotContent(data, snapshotAccountKey(data), undefined, true);
  assert.equal(first.sessions[0].messageCount, 700);
  assert.deepEqual(first.sessions[0].messages.map(message => message.id), full.messages.slice(-160).map(message => message.id));
  assert.equal(knownSessionContent(first)[full.id], first.sessions[0].historyToken);
  const second = compactSnapshotContent(data, snapshotAccountKey(data), knownSessionContent(first), true);
  assert.equal(second.sessions[0].messages, undefined);
  assert.equal(hydrateSnapshotContent(second, first)?.sessions[0].messages.length, 160);
  data.sideChats = [{ id: 'chat', parentId: full.id, projectId: 'project', parentTitle: full.title, capturedAt: full.createdAt, draft: '', session: { ...full, id: 'chat-session' } }];
  const withChat = compactSnapshotContent(data, snapshotAccountKey(data), undefined, true);
  assert.equal(withChat.sideChats?.[0].session.messageCount, 700);
  assert.equal(withChat.sideChats?.[0].session.messages.length, 160);
});

test('paged history retains reference receipts without presenting old sent results as removable pending inputs', () => {
  const full = session(); full.nativeId = 'current';
  full.sources = ['current', 'previous', 'unsent'].map(id => ({ id, name: id, sourcePath: `local-conclusion:${id}:v1`, localPath: '/frozen/' + id + '.md', sha256: 'hash-' + id, size: 1, fetchedAt: '' }));
  full.messages = Array.from({ length: 700 }, (_, index) => ({ ...full.messages[0], id: `m${index}` }));
  full.messages[0].context = { nativeId: 'previous', accepted: true, workRecord: false, sourceHashes: { previous: 'hash-previous' } };
  full.messages[1].context = { nativeId: 'current', accepted: true, workRecord: true, sourceHashes: { current: 'hash-current' } };
  full.messages[2].context = { nativeId: 'current', accepted: false, workRecord: false, sourceHashes: { unsent: 'hash-unsent' } };
  const data = snapshot(full), paged = compactSnapshotContent(data, snapshotAccountKey(data), undefined, true).sessions[0];
  assert.equal(paged.messages.length, 160);
  assert.deepEqual(acceptedSessionContext(paged), acceptedSessionContext(full));
  assert(sourceWasAccepted(paged, paged.sources[0])); assert(sourceWasAccepted(paged, paged.sources[1]));
  assert(!sourceWasAccepted(paged, paged.sources[2]));
  assert.deepEqual(pendingComposerReferences(paged, []).map(item => [item.source.id, item.removable]), [['unsent', true], ['previous', false]]);
  const compact = compactSnapshotContent(data, snapshotAccountKey(data), knownSessionContent(snapshot(paged)), true);
  assert.deepEqual(acceptedSessionContext(hydrateSnapshotContent(compact, snapshot(paged))!.sessions[0]), acceptedSessionContext(full));
  assert.deepEqual(acceptedSessionContext({ ...paged, nativeId: 'new-context' }).sourceHashes, {});
  assert(!sourceWasAccepted({ ...paged, id: 'another-session' }, paged.sources[0]));
  assert(!sourceWasAccepted({ ...paged, sources: [{ ...paged.sources[0], sha256: 'changed' }] }, { ...paged.sources[0], sha256: 'changed' }));
  assert.equal(full.referenceReceipts, undefined, 'renderer receipts never mutate persistent sessions');
});
