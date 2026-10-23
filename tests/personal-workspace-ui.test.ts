import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PersonalSection, SessionOrganization, PersonalMoveDialog } from '../src/renderer/personal-workspace';
import { personalProfile, personalBinding } from '../src/shared/personal-workspace';
import type { AgentSession } from '../src/shared/types';

const session = (id: string, personalGroupId?: string): AgentSession => ({
  id, title: id, provider: 'codex', purpose: 'work', cwd: '/test', status: 'idle',
  createdAt: '2026-10-22T00:00:00Z', autoUpload: false, handoffPath: '/test/' + id,
  sources: [], messages: [], approvals: [], personalGroupId,
});
const groups = [{ id: 'research', name: '资料研究' }, { id: 'history', name: '历史记录' }];
const render = (sessions: AgentSession[]) => renderToStaticMarkup(React.createElement(PersonalSection, {
  groups, sessions, active: true, selected: '', select() {}, move() {},
  call: async () => { throw new Error('No IPC expected while rendering'); }, changed: async () => {},
}));
function counts(html: string) {
  return {
    total: Number(html.match(/class="personal-count">(\d+)</)?.[1]),
    groups: Object.fromEntries([...html.matchAll(/<span>([^<]+)<\/span><small>(\d+)<\/small>/g)].map(match => [match[1], Number(match[2])])),
  };
}

test('unassigned counts decrease when conversations close and recover when reopened', () => {
  const sessions = [session('first'), session('second')];
  assert.deepEqual(counts(render(sessions)), { total: 2, groups: { 未分组: 2, 资料研究: 0, 历史记录: 0 } });
  sessions[0].closedAt = '2026-10-22T01:00:00Z';
  assert.deepEqual(counts(render(sessions)), { total: 1, groups: { 未分组: 1, 资料研究: 0, 历史记录: 0 } });
  sessions[1].closedAt = '2026-10-22T02:00:00Z';
  assert.deepEqual(counts(render(sessions)), { total: 0, groups: { 未分组: 0, 资料研究: 0, 历史记录: 0 } });
  delete sessions[0].closedAt;
  assert.deepEqual(counts(render(sessions)), { total: 1, groups: { 未分组: 1, 资料研究: 0, 历史记录: 0 } });
});

test('custom groups and the total count only open conversations, while closed-only groups remain movable', () => {
  const sessions = [session('unassigned'), session('active', 'research'), session('closed', 'research'), session('history', 'history')];
  sessions[2].closedAt = sessions[3].closedAt = '2026-10-22T01:00:00Z';
  const html = render(sessions);
  assert.deepEqual(counts(html), { total: 2, groups: { 未分组: 1, 资料研究: 1, 历史记录: 0 } });
  const moveButtons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).filter(button => button.includes('整组迁移到项目'));
  assert.equal(moveButtons.length, 2);
  for (const button of moveButtons) assert.doesNotMatch(button, /disabled=/, 'closed records still belong to a whole-group move');
});

test('project sessions use the same migration entry and dialog without unrelated personal group controls', () => {
  const call = async () => { throw new Error('No IPC while rendering'); };
  const item = session('project-session'); item.binding = personalBinding();
  const organization = () => renderToStaticMarkup(React.createElement(SessionOrganization, { session: item, groups, close() {}, move() {}, call, changed: async () => {} }));
  assert.match(organization(), /会话个人分组/);
  item.binding.project = { ...personalProfile.projects[0], id: 'project-a', name: '项目 A' };
  for (const host of ['personal', 'team.invalid']) {
    item.binding.host = host;
    const html = organization(); assert.match(html, /迁移到项目/); assert.match(html, /当前项目：项目 A/);
    assert.doesNotMatch(html, /会话个人分组|保存分组|从未分项目移除/);
  }
  const html = renderToStaticMarkup(React.createElement(PersonalMoveDialog, { selection: { sessionId: item.id, title: item.title, count: 3 }, projects: [{ ...item.binding.project, id: 'project-b', name: '项目 B' }], connected: false, connect() {}, call, close() {}, moved: async () => {} }));
  assert.match(html, /包含关联父子会话/); assert.match(html, /迁移 3 条会话/); assert.match(html, /项目 B/);
  assert.doesNotMatch(html, /连接中央节点|必须连接|__personal__/);
});
