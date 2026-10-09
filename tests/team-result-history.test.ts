import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { matchesTeamHistory, teamHistoryReason } from '../src/shared/team-result-history';
import { ContentFiles } from '../src/core/content-files';
import type { RemoteBinding } from '../src/shared/types';

test('history classification uses the record lifecycle, never its content or merge sources', () => {
  const ref = { scope: 'team' as const, projectId: 'p', id: 'combined', version: 1 };
  const current = { deletedAt: undefined, description: '已删除的问题说明', derivedFrom: [ref], provenance: [ref] };
  const merged = { supersededBy: ref }, deleted = { deletedAt: '2026-10-09T00:00:00Z', supersededBy: ref };
  assert.equal(teamHistoryReason(current), undefined);
  assert.equal(teamHistoryReason(merged), 'merged');
  assert.equal(teamHistoryReason(deleted), 'deleted', 'the record deletion takes precedence over an earlier merge');
  assert.equal(matchesTeamHistory(current, 'all'), false);
  assert.equal(matchesTeamHistory(merged, 'deleted'), false);
  assert.equal(matchesTeamHistory(deleted, 'merged'), false);
  assert.equal(matchesTeamHistory(merged, 'all'), true);
  assert.equal(matchesTeamHistory(deleted, 'all'), true);
});

test('disk history separates edited versions, merged sources and deletions after deleting the merged result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-history-reasons-'));
  const files = new ContentFiles(root, async () => ({ username: 'alice', admin: true }));
  const binding = { connectionId: 'c', host: 'local', port: 22, fingerprint: 'SHA256:fixture', username: 'alice', project: { id: 'p', name: '历史分类', remoteRoot: '/p', uploadPath: '/p/submissions/alice', historyPath: '/p/trajectories/alice' } } as RemoteBinding;
  const source = path.join(root, 'source.md'); await fs.writeFile(source, '研究记录');
  const publish = (title: string) => files.publish(binding, source, `/p/submissions/alice/explorations/${title}.md`, { title, description: '证据', kind: 'contribution', category: 'exploration' });
  try {
    const a = await publish('来源A'), b = await publish('来源B'), c = await publish('单独删除');
    const edited = (await files.edit(binding, { id: a.id, revision: 1, action: 'save', title: a.title, description: '补充证据', curate: true, merge: [] }))!;
    const merged = await files.merge(binding, { sources: [edited, b].map(item => ({ id: item.id, revision: item.revision })), replaceIds: [a.id, b.id], title: '合并成果', description: '统一研究记录' });
    await files.edit(binding, { id: c.id, revision: 1, action: 'delete', curate: true, merge: [] });
    await files.edit(binding, { id: merged.id, revision: 1, action: 'delete', curate: true, merge: [] });
    const history = await files.history(binding), ids = (filter: 'all' | 'merged' | 'deleted') => history.filter(item => matchesTeamHistory(item, filter)).map(item => item.id).sort();
    assert.deepEqual(ids('merged'), [a.id, b.id].sort());
    assert.deepEqual(ids('deleted'), [c.id, merged.id].sort());
    assert.equal(ids('all').length, 4);
    assert.equal(teamHistoryReason(history.find(item => item.id === a.id && item.revision === 1)!), undefined);
    assert.equal(history.find(item => item.id === a.id && item.revision === 2)!.description, '补充证据');
    assert(history.filter(item => matchesTeamHistory(item, 'deleted')).every(item => !item.description));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('earlier edit-and-merge records are classified without migrating the stored files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-history-legacy-'));
  const files = new ContentFiles(root, async () => ({ username: 'alice', admin: true }));
  const binding = { connectionId: 'c', host: 'local', port: 22, fingerprint: 'SHA256:fixture', username: 'alice', project: { id: 'p', name: '兼容历史', remoteRoot: '/p', uploadPath: '/p/submissions/alice', historyPath: '/p/trajectories/alice' } } as RemoteBinding;
  const source = path.join(root, 'source.md'); await fs.writeFile(source, '来源正文');
  const publish = (title: string) => files.publish(binding, source, `/p/submissions/alice/explorations/${title}.md`, { title, description: '来源正文', kind: 'contribution', category: 'exploration' });
  try {
    const a = await publish('保留原ID'), b = await publish('被合并来源');
    const legacyFile = path.join(root, 'p', '.workbench-content-history.json');
    const saved = JSON.stringify([a, { ...b, supersededBy: { scope: 'team', projectId: 'p', id: a.id, version: 2 }, supersededAt: a.updatedAt }]);
    await fs.writeFile(legacyFile, saved);
    const history = await files.history(binding);
    assert.deepEqual(history.filter(item => matchesTeamHistory(item, 'merged')).map(item => item.id), [b.id]);
    assert.equal(teamHistoryReason(history.find(item => item.id === a.id)!), undefined);
    assert.equal(await fs.readFile(legacyFile, 'utf8'), saved);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
