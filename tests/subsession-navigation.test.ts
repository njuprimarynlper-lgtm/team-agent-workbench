import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentSession, WorkbenchAPI } from '../src/shared/types';
import { childForSelectedParent, subsessionSiblings } from '../src/shared/subsessions';
import { SubsessionWorkspace } from '../src/renderer/subsession-workspace';

const session = (id: string, parentId?: string): AgentSession => ({ id, title: id, parentId, provider: 'codex', purpose: 'work', status: 'idle', cwd: '/test', createdAt: '', messages: [], sources: [], approvals: [], autoUpload: false, handoffPath: '', ...(parentId ? { fork: { parentId } as AgentSession['fork'] } : {}) });

test('right-side groups contain only open direct siblings, not descendants or other families', () => {
  const a = session('a'), b = session('b'), a1 = session('a1', 'a'), a2 = session('a2', 'a'), b1 = session('b1', 'b'), nested = session('nested', 'a1');
  const closed = { ...session('closed', 'a'), closedAt: 'now' }, prepare = { ...session('prepare', 'a'), purpose: 'prepare' as const };
  const promoted = session('promoted', 'a'); promoted.fork!.promotedAt = 'now';
  const sessions = [a, b, a1, a2, b1, nested, closed, prepare, promoted];
  assert.deepEqual(subsessionSiblings(sessions, a1).map(s => s.id), ['a1', 'a2']);
  assert.deepEqual(subsessionSiblings(sessions, b1).map(s => s.id), ['b1']);
  assert.deepEqual(subsessionSiblings(sessions, nested).map(s => s.id), ['nested']);
  assert.deepEqual(subsessionSiblings(sessions, promoted), []);
  assert.deepEqual(subsessionSiblings(sessions, a), []);
});

test('selecting another parent changes the side-pane family and cannot retain its previous child', () => {
  const sessions = [session('a'), session('a1', 'a'), session('a2', 'a'), session('nested', 'a1'), session('b'), session('b1', 'b'), session('empty')];
  assert.equal(childForSelectedParent(sessions, 'a', 'a2'), 'a2');
  assert.equal(childForSelectedParent(sessions, 'a', 'nested'), 'nested');
  assert.equal(childForSelectedParent(sessions, 'b', 'a2'), 'b1');
  assert.equal(childForSelectedParent(sessions, 'empty', 'b1'), '');
  sessions.find(s => s.id === 'a2')!.closedAt = 'now';
  assert.equal(childForSelectedParent(sessions, 'a', 'a2'), 'a1');
  sessions.find(s => s.id === 'a1')!.closedAt = 'now';
  assert.equal(childForSelectedParent(sessions, 'a', 'a2'), 'nested');
});

test('sibling navigation survives missing parents without inventing a shared root group', () => {
  const a = session('a', 'missing-a'), sibling = session('sibling', 'missing-a'), b = session('b', 'missing-b');
  assert.deepEqual(subsessionSiblings([a, sibling, b], a).map(s => s.id), ['a', 'sibling']);
});

test('switcher labels the parent group and current tab, retaining the existing child chat controls', () => {
  const a = session('父会话 A'), a1 = session('方案一', a.id), a2 = session('方案二', a.id), b1 = session('其他父会话的子会话', 'b');
  const html = renderToStaticMarkup(React.createElement(SubsessionWorkspace, { session: a1, sessions: [a, a1, a2, b1], api: {} as WorkbenchAPI, active: true, edit() {}, open() {}, promote() {}, remove() {}, closed() {}, changed: async () => {} }));
  assert.match(html, /role="tablist" aria-label="父会话「父会话 A」的子会话"/);
  assert.equal((html.match(/role="tab"/g) || []).length, 2);
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  assert.match(html, /方案二/); assert.doesNotMatch(html, /其他父会话的子会话/);
  assert.match(html, /更多子会话操作/); assert.match(html, /aria-label="子会话输入"/);
});
