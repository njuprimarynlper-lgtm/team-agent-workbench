import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const data = path.resolve('.test-data', 'admin-storage-' + Date.now());
const shared = path.join(data, 'share'), adminData = path.join(data, 'admin');
const writeSized = async (relative, size) => {
  const file = path.join(shared, ...relative.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.alloc(size, 65));
};

await fs.mkdir(path.join(shared, '.workbench-local'), { recursive: true });
await fs.mkdir(adminData, { recursive: true });
const state = {
  initialized: true, teamId: 'storage-ui', loginGroup: 'local_members', sftpConfigured: true, storageVersion: 1, operations: {},
  users: {
    alice: { username: 'alice', name: 'Alice', enabled: true, groups: ['local_ocr'], contentAdminGroups: ['local_ocr'] },
    bob: { username: 'bob', name: 'Bob', enabled: true, groups: ['local_ocr'], contentAdminGroups: [] },
  },
  groups: { local_ocr: { name: 'local_ocr', label: 'OCR', adminGroup: 'local_ocr_admins', workspace: '/projects/OCR' } },
};
await fs.writeFile(path.join(shared, '.workbench-local', 'registry.json'), JSON.stringify({ version: 1, administrator: 'admin', credentials: {}, state }, null, 2));
await fs.writeFile(path.join(adminData, 'connection.json'), JSON.stringify({ mode: 'local', localRoot: shared, host: 'local', port: 22, username: 'admin', fingerprint: 'LOCAL:storage-ui', root: '/srv/teamspace' }, null, 2));
await writeSized('projects/OCR/识别优化/.workbench-project.json', 2);
await writeSized('projects/OCR/识别优化/submissions/alice/conclusions/result.md', 2048);
await writeSized('projects/OCR/识别优化/trajectories/alice/run.zip', 4096);
await writeSized('projects/OCR/识别优化/curated/final.md', 1024);

let app;
try {
  app = await electron.launch({ args: ['dist/admin'], cwd: root, env: { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_ADMIN_DATA_DIR: adminData } });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '共享空间', exact: true }).click();
  await expect(page.getByRole('button', { name: '共享空间', exact: true })).toHaveClass(/active/);
  await expect(page.getByRole('button', { name: '用户管理', exact: true })).not.toHaveClass(/active/);
  await expect(page.getByRole('heading', { name: '共享空间', exact: true })).toBeVisible();
  await expect(page.getByText('内容构成', { exact: true })).toBeVisible();
  await expect.poll(async () => page.locator('.admin-nav-item').evaluateAll(items => items.slice(0, 2).map(item => getComputedStyle(item).backgroundColor))).toEqual(['rgba(0, 0, 0, 0)', 'rgb(42, 65, 88)']);
  await expect(page.locator('.storage-donut')).toBeVisible();
  await expect(page.locator('.group-usage-list article')).toHaveCount(1);
  await expect(page.locator('.group-usage-list article')).toContainText('OCR');
  await expect(page.locator('.group-usage-list article')).toContainText('7.00 KB');
  await page.screenshot({ path: path.join(data, 'shared-storage-overview.png'), fullPage: true });

  await page.getByRole('tab', { name: '用户', exact: true }).click();
  const alice = page.locator('.storage-table-card tbody tr').filter({ hasText: 'Alice' });
  await expect(alice).toContainText('6.00 KB');
  await expect(alice).toContainText('OCR');

  await page.getByRole('tab', { name: '文件夹', exact: true }).click();
  await page.getByRole('button', { name: /projects/ }).click();
  await expect(page.locator('.storage-breadcrumb')).toContainText('projects');
  await page.getByRole('button', { name: /OCR/ }).click();
  await expect(page.locator('.storage-breadcrumb')).toContainText('OCR');
  await expect(page.locator('.storage-folders tbody')).toContainText('识别优化');
  await page.screenshot({ path: path.join(data, 'shared-storage-folders.png'), fullPage: true });
  console.log(JSON.stringify({ passed: true, screenshots: [path.join(data, 'shared-storage-overview.png'), path.join(data, 'shared-storage-folders.png')] }));
} finally {
  await app?.close();
}
