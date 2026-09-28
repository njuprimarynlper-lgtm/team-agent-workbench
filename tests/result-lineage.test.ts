import test from 'node:test';
import assert from 'node:assert/strict';
import { newerTeamSources, resultLineage } from '../src/shared/result-lineage';
import type { ResultReference } from '../src/shared/content';

const ref = (id: string, version = 1): ResultReference => ({ scope: 'personal', projectId: 'p', id, version });
test('lineage traverses frozen versions bottom-up without duplicating a shared ancestor', () => {
  const a = ref('a'), b = ref('b'), c = ref('c'), d = ref('d');
  const nodes = new Map([['c', { derivedFrom: [a, b] }], ['d', { derivedFrom: [b] }]]);
  assert.deepEqual(resultLineage([c, d], item => nodes.get(item.id)), [a, b, c, d]);
  assert.deepEqual(resultLineage([ref('a', 1), ref('a', 2)], () => undefined), [ref('a', 1), ref('a', 2)]);
});
test('lineage rejects cycles rather than silently changing source identity', () => {
  const a = ref('a'), b = ref('b');
  assert.throws(() => resultLineage([a], item => item.id === 'a' ? { derivedFrom: [b] } : { derivedFrom: [a] }), /循环/);
});
test('E keeps its frozen personal D copy while reporting a newer upstream team D', () => {
  const projectId = 'p', c: ResultReference = { scope: 'personal', projectId, id: 'c', version: 1 };
  const personalD: ResultReference = { scope: 'personal', projectId, id: 'personal-d', version: 1 };
  const teamD: ResultReference = { scope: 'team', projectId, id: 'team-d', version: 1 };
  const nodes = new Map([['c', { derivedFrom: [] }], ['personal-d', { derivedFrom: [teamD] }]]);
  assert.deepEqual(newerTeamSources([c, personalD], source => nodes.get(source.id), { 'team-d': 2 }), [teamD]);
  assert.deepEqual(newerTeamSources([c, personalD], source => nodes.get(source.id), { 'team-d': 1 }), []);
  assert.equal(teamD.version, 1, 'an upstream update does not rewrite E\'s saved source version');
});
