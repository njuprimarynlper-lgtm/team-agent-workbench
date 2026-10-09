import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { catalogProjects, purgeProject } from '../src/admin/project-purge';
import type { AdminState } from '../src/admin/types';

const projectId = 'project_' + 'c'.repeat(32);

test('local project purge can delete everything or keep trajectories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-purge-'));
  const state: AdminState = {
    initialized: true,
    users: {},
    groups: { algo: { name: 'algo', label: '算法', adminGroup: 'algo_admins', workspace: '/projects/算法' } },
  };
  const project = path.join(root, 'projects', '算法', '华为算法大赛');
  const prefix = '/projects/算法/华为算法大赛';
  try {
    await fs.mkdir(path.join(project, 'submissions', 'alice'), { recursive: true });
    await fs.mkdir(path.join(project, 'trajectories', 'alice'), { recursive: true });
    await fs.mkdir(path.join(project, '.brief-versions'), { recursive: true });
    await fs.mkdir(path.join(root, '.workbench-local'), { recursive: true });
    await fs.writeFile(path.join(project, '.workbench-project.json'), JSON.stringify({ id: projectId, name: '华为算法大赛' }));
    await fs.writeFile(path.join(project, '项目说明.md'), 'brief');
    await fs.writeFile(path.join(project, '.brief-versions', '1.md'), 'v1');
    await fs.writeFile(path.join(project, 'submissions', 'alice', 'a.md'), 'result');
    await fs.writeFile(path.join(project, 'trajectories', 'alice', 'run.zip'), 'zip');
    await fs.writeFile(path.join(project, 'loose.bin'), 'loose');
    await fs.writeFile(path.join(project, '.workbench-content.json'), JSON.stringify([
      { id: 'file', path: prefix + '/submissions/alice/a.md' },
      { id: 'trajectory', path: prefix + '/trajectories/alice/run.zip' },
    ]));
    await fs.writeFile(path.join(project, '.workbench-content-history.json'), JSON.stringify([
      { id: 'old-file', path: prefix + '/submissions/alice/old.md' },
      { id: 'old-trajectory', path: prefix + '/trajectories/alice/old.zip' },
    ]));
    await fs.writeFile(path.join(root, '.workbench-local', 'upload-receipts.json'), JSON.stringify({
      submission: { path: prefix + '/submissions/alice/a.md' },
      trajectory: { path: prefix + '/trajectories/alice/run.zip' },
      outside: { path: '/projects/算法/其他/keep.txt' },
    }));
    const other = path.join(root, 'projects', '算法', '其他');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, '.workbench-project.json'), JSON.stringify({ id: 'project_' + 'd'.repeat(32), name: '其他' }));
    await fs.writeFile(path.join(other, 'keep.txt'), 'stay');

    const catalog = await catalogProjects(root, state);
    assert.deepEqual(catalog.map(item => item.name).sort(), ['其他', '华为算法大赛'].sort());

    const kept = await purgeProject(root, state, projectId, 'keep_trajectories');
    assert.equal(kept.removedFiles, 2);
    await assert.rejects(fs.stat(path.join(project, 'submissions')));
    assert.equal(await fs.readFile(path.join(project, 'trajectories', 'alice', 'run.zip'), 'utf8'), 'zip');
    assert.equal(await fs.readFile(path.join(project, '项目说明.md'), 'utf8'), 'brief');
    const content = JSON.parse(await fs.readFile(path.join(project, '.workbench-content.json'), 'utf8'));
    const history = JSON.parse(await fs.readFile(path.join(project, '.workbench-content-history.json'), 'utf8'));
    assert.deepEqual(content.map((item: { id: string }) => item.id), ['trajectory']);
    assert.deepEqual(history.map((item: { id: string }) => item.id), ['old-trajectory']);
    const receipts = JSON.parse(await fs.readFile(path.join(root, '.workbench-local', 'upload-receipts.json'), 'utf8'));
    assert.deepEqual(Object.keys(receipts).sort(), ['outside', 'trajectory']);
    assert.equal(await fs.readFile(path.join(other, 'keep.txt'), 'utf8'), 'stay');

    await fs.mkdir(path.join(project, 'submissions'), { recursive: true });
    await fs.writeFile(path.join(project, 'submissions', 'again.md'), 'again');
    const cleared = await purgeProject(root, state, projectId, 'all');
    assert.equal(cleared.removedFiles, 2);
    await assert.rejects(fs.stat(path.join(project, 'trajectories')));
    await assert.rejects(fs.stat(path.join(project, 'submissions')));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, '.workbench-content.json'), 'utf8')), []);
    assert.equal(await fs.readFile(path.join(project, '.workbench-project.json'), 'utf8'), JSON.stringify({ id: projectId, name: '华为算法大赛' }));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
