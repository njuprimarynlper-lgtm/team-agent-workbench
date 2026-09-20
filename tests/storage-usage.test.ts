import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanLocalStorage } from '../src/admin/storage-usage';
import { storageScanSchema, type AdminState } from '../src/admin/types';

const writeSized = async (file: string, size: number) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, Buffer.alloc(size, 65)); };

test('shared storage scan attributes groups, users and folders without reading file contents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-storage-'));
  const state: AdminState = {
    initialized: true,
    users: {
      alice: { username: 'alice', name: 'Alice', enabled: true, groups: ['local_ocr', 'local_nlp'] },
      bob: { username: 'bob', name: 'Bob', enabled: true, groups: ['local_ocr'] },
    },
    groups: {
      local_ocr: { name: 'local_ocr', label: 'OCR', adminGroup: 'local_ocr_admins', workspace: '/projects/OCR' },
      local_nlp: { name: 'local_nlp', label: '实体抽取', adminGroup: 'local_nlp_admins', workspace: '/projects/实体抽取' },
    },
  };
  try {
    await writeSized(path.join(root, '.workbench', 'admin', 'state.json'), 11);
    await writeSized(path.join(root, 'projects', 'OCR', '识别优化', '.workbench-project.json'), 2);
    await writeSized(path.join(root, 'projects', 'OCR', '识别优化', 'submissions', 'alice', 'conclusions', 'a.md'), 10);
    await writeSized(path.join(root, 'projects', 'OCR', '识别优化', 'trajectories', 'alice', 'run.zip'), 20);
    await writeSized(path.join(root, 'projects', 'OCR', '识别优化', 'curated', 'result.md'), 30);
    await writeSized(path.join(root, 'projects', 'OCR', '识别优化', '项目说明.md'), 5);
    await writeSized(path.join(root, 'projects', 'OCR', '识别优化', 'submissions', 'ghost', 'unknown.bin'), 7);
    await writeSized(path.join(root, 'projects', 'OCR', 'loose.bin'), 3);
    await writeSized(path.join(root, 'other.bin'), 4);
    const report = await scanLocalStorage(root, state, { path: '', offset: 0, limit: 100 });
    const categories = Object.fromEntries(report.categories.map(item => [item.key, item.bytes]));
    assert.deepEqual(categories, { submissions: 10, trajectories: 20, curated: 30, project: 7, system: 11, unassigned: 14 });
    assert.equal(report.total.bytes, 92); assert.equal(report.total.files, 9);
    assert.equal(report.groups[0].bytes, 77); assert.equal(report.groups[0].projects, 1); assert.equal(report.groups[0].members, 2);
    assert.equal(report.users.find(user => user.username === 'alice')!.bytes, 30);
    assert.equal(report.users.find(user => user.username === 'bob')!.bytes, 0);
    assert.equal(report.children[0].name, 'projects');

    const project = await scanLocalStorage(root, state, { path: 'projects/OCR/识别优化', offset: 0, limit: 2 });
    assert.equal(project.total.bytes, 74); assert.equal(project.children.length, 2); assert(project.childCount > project.children.length);
    const rest = await scanLocalStorage(root, state, { path: project.path, offset: 2, limit: 100 });
    assert.equal(new Set([...project.children, ...rest.children].map(item => item.name)).size, project.childCount);

    const controller = new AbortController(); controller.abort();
    await assert.rejects(scanLocalStorage(root, state, { path: '', offset: 0, limit: 100 }, controller.signal), /取消/);
    for (const unsafe of ['/etc', '../outside', 'projects\\OCR', 'projects//OCR', 'projects/OCR/']) assert.equal(storageScanSchema.safeParse({ path: unsafe }).success, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('shared storage scan skips links that leave the managed root', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-storage-link-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-storage-outside-'));
  try {
    await writeSized(path.join(outside, 'secret.bin'), 64);
    try { await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch { t.skip('当前系统不允许测试进程创建目录链接'); return; }
    const report = await scanLocalStorage(root, { initialized: true, users: {}, groups: {} }, { path: '', offset: 0, limit: 100 });
    assert.equal(report.total.bytes, 0); assert.equal(report.warningCount, 1); assert.match(report.warnings[0].message, /链接/);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});
