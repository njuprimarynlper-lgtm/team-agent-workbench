import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentSession, SourceFile, WorkbenchAPI } from '../src/shared/types';
import { composerReferenceLayout, pendingComposerReferences, referenceTabMetrics, toggleComposerReference } from '../src/renderer/composer-references';
import { SessionSyncFrame } from '../src/renderer/session-sync-frame';
import { sessionContext } from '../src/core/session-context';

const source = (id: string, sourcePath = '/team/' + id): SourceFile => ({ id, sourcePath, name: id, localPath: '/snapshots/' + id + '.md', sha256: id, size: 4, fetchedAt: '' });
const session = (...sources: SourceFile[]): AgentSession => ({ id: 's', nativeId: 'native', purpose: 'work', provider: 'codex', title: '', cwd: '/project', createdAt: '', status: 'idle', handoffPath: '', messages: [], approvals: [], sources, autoUpload: false });

test('More takes space only when needed, overlapping waists and bounded title widths remain stable', () => {
  assert.equal(referenceTabMetrics.overlap, referenceTabMetrics.waist * 2);
  for (let available = 116; available <= 2400; available += 7) for (const count of [0, 1, 2, 6, 30, 100]) {
    const layout = composerReferenceLayout(available, count);
    assert(layout.occupied <= available);
    assert.equal(layout.visible + layout.hidden, count);
    if (layout.visible) assert(layout.width >= referenceTabMetrics.minimum && layout.width <= referenceTabMetrics.maximum);
    assert.equal(layout.occupied - layout.visible * (layout.width - referenceTabMetrics.overlap), layout.hidden ? referenceTabMetrics.more : count ? referenceTabMetrics.overlap : 0);
    if (count * (referenceTabMetrics.minimum - referenceTabMetrics.overlap) + referenceTabMetrics.overlap <= available) assert.equal(layout.hidden, 0);
  }
  assert.equal(composerReferenceLayout(170, 6).visible, 0);
  assert.equal(composerReferenceLayout(196, 6).visible, 1);
  assert.equal(composerReferenceLayout(900, 1).width, 180);
  for (const width of [0, -1, NaN, Infinity]) assert.equal(composerReferenceLayout(width, 6).visible, 0);
});

test('the exact fitting boundary removes More instead of using its reserved width to create overflow', () => {
  assert.deepEqual(composerReferenceLayout(500, 0), { visible: 0, hidden: 0, width: 0, occupied: 0 });
  for (const count of [1, 2, 3, 8]) {
    const boundary = 120 + (count - 1) * 80;
    assert.equal(composerReferenceLayout(boundary - 1, count).hidden > 0, true);
    assert.equal(composerReferenceLayout(boundary, count).hidden, 0);
    assert.equal(composerReferenceLayout(boundary, count).occupied, boundary);
  }
});

test('shrinking reveals the newest sources from the right without modifying selection or execution inputs', () => {
  const s = session(...Array.from({ length: 8 }, (_, i) => source('file-' + i)));
  const ids = s.sources.map(item => item.id), before = structuredClone(s), items = pendingComposerReferences(s, ids);
  assert.deepEqual(items.map(item => item.source.id), [...ids].reverse());
  for (const width of [116, 196, 400, 750]) {
    const visible = items.slice(0, composerReferenceLayout(width, items.length).visible).reverse();
    if (visible.length) assert.equal(visible.at(-1)!.source.id, 'file-7');
    assert.deepEqual(sessionContext(s, 'continue', ids).sources.map(item => item.id), ids);
  }
  assert.deepEqual(s, before);
});

test('duplicate snapshots share selection; automatic, removable, and already accepted sources retain their rules', () => {
  const brief = source('brief'), alias = { ...brief, id: 'brief-alias' };
  const result = source('result', 'local-conclusion:result:v1'), normal = source('local');
  const duplicate = { ...normal, id: 'local-alias' };
  const s = session(brief, alias, result, normal, duplicate);
  s.projectBrief = { sourceId: alias.id } as AgentSession['projectBrief'];
  let items = pendingComposerReferences(s, [duplicate.id]);
  assert.equal(items.length, 3);
  assert.equal(items.find(item => item.source.id === brief.id)?.automatic, true);
  assert.equal(items.find(item => item.source.id === brief.id)?.removable, false);
  assert.equal(items.find(item => item.source.id === result.id)?.removable, true);
  assert.equal(items.find(item => item.source.id === result.id)?.selected, true);
  assert.equal(items.find(item => item.source.id === normal.id)?.selected, true);
  assert.deepEqual(toggleComposerReference(s, [normal.id, duplicate.id, result.id], normal), [result.id]);
  assert.deepEqual(toggleComposerReference(s, [], normal), [normal.id]);
  s.messages.push({ id: 'accepted', role: 'user', text: 'sent', createdAt: '', context: { nativeId: 'native', accepted: true, sourceHashes: { [duplicate.id]: normal.sha256 }, workRecord: false } });
  items = pendingComposerReferences(s, [normal.id]);
  assert(!items.some(item => item.source.id === normal.id));
  s.messages.push({ id: 'older-native', role: 'user', text: 'sent earlier', createdAt: '', context: { nativeId: 'previous', accepted: true, sourceHashes: { [result.id]: result.sha256 }, workRecord: false } });
  assert.equal(pendingComposerReferences(s, []).find(item => item.source.id === result.id)?.removable, false);
});

test('project updates replace pending brief tabs and stale draft selections instead of stacking versions', () => {
  const old = { ...source('old', '/project/项目说明.md'), name: '项目说明 · v1' };
  const latest = { ...source('latest', old.sourcePath), name: '项目说明 · v2' };
  const other = { ...old, id: 'other-project', sourcePath: '/another/项目说明.md' };
  const notes = { ...old, id: 'notes', name: '手动对比资料', sha256: 'notes' };
  const s = session(old, latest, other, notes);
  s.projectBrief = { revision: 2, sourceId: latest.id, capturedAt: '' };
  const before = structuredClone(s);
  assert.deepEqual(pendingComposerReferences(s, [old.id]).map(item => item.source.id), [notes.id, other.id, latest.id]);
  const input = sessionContext(s, '继续', [old.id]);
  assert.deepEqual(input.sources.map(item => item.id), [latest.id]);
  assert.deepEqual(sessionContext(s, '比较资料', [old.id, other.id, notes.id]).sources.map(item => item.id), [other.id, notes.id, latest.id]);
  assert.deepEqual(s, before, 'historical snapshots and messages remain unchanged');
  s.messages.push({ id: 'failed', role: 'user', text: input.text, createdAt: '', context: { ...input.context, nativeId: s.nativeId!, accepted: false } });
  assert(pendingComposerReferences(s, []).some(item => item.source.id === latest.id));
  s.messages.push({ id: 'sent', role: 'user', text: input.text, createdAt: '', context: { ...input.context, nativeId: s.nativeId!, accepted: true } });
  assert(!pendingComposerReferences(s, [old.id]).some(item => [old.id, latest.id].includes(item.source.id)));
  assert.equal(sessionContext(s, '再继续', [old.id]).text, '再继续');
  s.nativeId = 'new-native';
  assert.deepEqual(sessionContext(s, '恢复上下文', [old.id]).sources.map(item => item.id), [latest.id]);
});

test('main and child composers keep their drafts and stable sync controls alongside a collapsed references menu', () => {
  const api = { call: async () => { throw new Error('Rendering must not read files or execute an agent'); } } as unknown as WorkbenchAPI;
  for (const child of [false, true]) {
    const s = session(source('report'));
    if (child) s.fork = { parentSessionId: 'parent', sourceId: 'report', inheritedSourceIds: [] } as unknown as AgentSession['fork'];
    const html = renderToStaticMarkup(React.createElement(SessionSyncFrame, {
      session: s, api, changed: async () => {}, references: { sourceIds: ['report'], select: () => {}, detach: async () => {} },
      children: React.createElement('textarea', { defaultValue: 'keep draft' }),
    }));
    assert.match(html, /session-composer-tabs/);
    assert.match(html, /更多参考资料，共 1 份/);
    assert.match(html, /<textarea>keep draft<\/textarea>/);
    assert(html.indexOf('session-sync-tab') < html.indexOf('composer-references'));
  }
});

test('an empty composer has no More tab or disabled placeholder', () => {
  const html = renderToStaticMarkup(React.createElement(SessionSyncFrame, {
    session: session(), api: {} as WorkbenchAPI, changed: async () => {}, references: { sourceIds: [], select: () => {}, detach: async () => {} },
    children: React.createElement('textarea', { defaultValue: 'keep draft' }),
  }));
  assert.doesNotMatch(html, /composer-reference-more|更多参考资料/);
  assert.match(html, /session-sync-tab/); assert.match(html, /<textarea>keep draft<\/textarea>/);
});
