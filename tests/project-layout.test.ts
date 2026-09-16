import test from 'node:test';
import assert from 'node:assert/strict';
import { newProjectLayout, projectName } from '../src/core/project-layout';

test('project names are single Unicode path components and trajectories remain inside the project', () => {
  const project = newProjectLayout('/projects', ' 实体抽取 ');
  assert.equal(project.name, '实体抽取');
  assert.equal(project.remoteRoot, '/projects/实体抽取');
  assert.equal(project.historyPath, '/projects/实体抽取/trajectories');
  for (const name of ['', '.', '..', '../OCR', 'ocr/a', 'ocr\\a', '\x00name', '.hidden', 'name.', '中'.repeat(61)]) assert.throws(() => projectName(name));
  assert.equal(projectName('OCR 迭代 2'), 'OCR 迭代 2');
});
