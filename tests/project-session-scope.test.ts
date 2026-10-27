import test from 'node:test';
import assert from 'node:assert/strict';
import { inProjectWorkgroup, projectWorkSessions } from '../src/shared/project-session-scope';
import type { AgentSession, Project } from '../src/shared/types';
import { personalBinding, personalProfile } from '../src/shared/personal-workspace';
const project = (id: string, groupName?: string): Project => ({ id, groupName, name: id, remoteRoot: '/' + id, uploadPath: '/' + id, historyPath: '/' + id });
test('imported sessions remain in their project when old bindings omit or retain an outdated group', () => {
  const selected = project('research', 'current-group');
  for (const group of [undefined, 'old-group']) assert(inProjectWorkgroup(project('research', group), selected, [selected]));
});

test('project counts and lists use one scope: no preparation, other projects or personal/team collisions', () => {
  const a = project('a'), b = project('b');
  const session = (id: string, p: Project, extra = {}) => ({ id, purpose: 'work', binding: { project: p }, ...extra } as AgentSession);
  const sessions = [session('open', a), session('closed', a, { closedAt: 'now' }), session('child', a, { fork: { parentId: 'open' } }), session('prepare', a, { purpose: 'prepare' }), session('background', a, { purpose: 'background' }), session('other', b), session('personal', a, { binding: personalBinding(a) })];
  const scoped = projectWorkSessions(sessions, a, [a,b], false);
  assert.deepEqual(scoped.map(s => s.id), ['open', 'closed', 'child']); assert.equal(scoped.filter(s => !s.closedAt).length, 2);
  assert.deepEqual(projectWorkSessions(sessions, a, [a,b], true).map(s => s.id), ['personal']);
  const p = personalProfile.projects[0]; const unassigned = [session('ungrouped', p, { binding: personalBinding() }), session('grouped', p, { binding: personalBinding(), personalGroupId: 'g' })];
  assert.deepEqual(projectWorkSessions(unassigned, p, [], true, '').map(s => s.id), ['ungrouped']);
  assert.equal(projectWorkSessions(unassigned, p, [], true, '*').length, 2);
});
test('group lists use current membership and never a matching display name or stale saved group', () => {
  const selected = project('research', 'current-group'), peer = project('delivery', 'current-group'), other = project('other', 'other-group');
  const projects = [selected, peer, other];
  assert(inProjectWorkgroup(project(peer.id, 'old-group'), selected, projects));
  assert(!inProjectWorkgroup(project(other.id, 'current-group'), selected, projects));
  assert(!inProjectWorkgroup(project('deleted', 'current-group'), selected, projects));
  assert(!inProjectWorkgroup({ ...project('another'), name: selected.name }, selected, projects));
  assert(!inProjectWorkgroup(project('other'), project('research'), projects));
  assert(!inProjectWorkgroup(undefined, selected, projects));
  assert(!inProjectWorkgroup(peer, undefined, projects));
});
