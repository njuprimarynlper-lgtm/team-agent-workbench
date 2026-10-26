import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { workspaceSelection, restoredWorkspaceSelection } from '../src/shared/workspace-selection';
import { PERSONAL_PROJECT_ID, personalProfile } from '../src/shared/personal-workspace';
import { LocalWorkspaceNote, SidebarProjectItem } from '../src/renderer/sidebar-project-item';

const local = { ...personalProfile.projects[0], id: 'local-project', name: '算法研究' };
const team = { ...local, id: 'team-project', name: '算法研究' };
const profile = { ...personalProfile, host: 'team.invalid', projects: [team] };

test('local and team selections retain their ids and validate the correct project list', () => {
  assert.equal(workspaceSelection(true, local.id, [local]), local.id);
  assert.equal(workspaceSelection(true, undefined, [local]), PERSONAL_PROJECT_ID);
  assert.equal(workspaceSelection(true, PERSONAL_PROJECT_ID, [local], profile), PERSONAL_PROJECT_ID);
  assert.equal(workspaceSelection(false, team.id, [local], profile), team.id);
  assert.throws(() => workspaceSelection(true, team.id, [local], profile), /本机项目已不存在/);
  assert.throws(() => workspaceSelection(false, local.id, [local], profile), /访问权限/);
  assert.throws(() => workspaceSelection(false, team.id, [local]), /尚未就绪/);
});

test('restart keeps valid local and team choices and falls back for removed projects without choosing a same-name project', () => {
  for (const id of [local.id, team.id, PERSONAL_PROJECT_ID]) assert.equal(restoredWorkspaceSelection(id, [local], [team]), id);
  assert.equal(restoredWorkspaceSelection(local.id, [], [team]), PERSONAL_PROJECT_ID);
  assert.equal(restoredWorkspaceSelection(team.id, [local], []), PERSONAL_PROJECT_ID);
  assert.equal(restoredWorkspaceSelection(undefined, [local], [team]), undefined);
});

test('a project row displays its role and controls without a second group heading', () => {
  const html = renderToStaticMarkup(React.createElement(SidebarProjectItem, {
    project: local, role: 'creator', selected: false, select() {}, settings() {}, call: async () => { throw new Error('No IPC while rendering'); },
  }));
  assert.match(html, /创建者/); assert.match(html, /data-project-id="local-project"/);
  assert.match(html, /aria-label="项目设置：算法研究"/);
  assert.doesNotMatch(html, /工作组|未关联工作组|workgroup-title/);
});

test('the sidebar note names the selected local project while unassigned sessions retain personal group labels', () => {
  const note = (project: typeof local, groupId: string) => renderToStaticMarkup(React.createElement(LocalWorkspaceNote, {
    project, groupId, groups: [{ id: 'study', name: '资料研究' }], openResults() {},
  }));
  for (const group of ['', '*', 'study']) assert.match(note(local, group), /<b>算法研究<\/b>/);
  const unassigned = personalProfile.projects[0];
  assert.match(note(unassigned, ''), /<b>未分组<\/b>/);
  assert.match(note(unassigned, '*'), /<b>全部本机会话<\/b>/);
  assert.match(note(unassigned, 'study'), /<b>资料研究<\/b>/);
});
