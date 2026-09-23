import { _electron as electron, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { offlineSettings, offlineProjectId } from '../tests/fixtures/offline-workspace.mjs';
import { publishRuntimeAssets } from './build-assets.mjs';

const expect = baseExpect.configure({ timeout: 15000 });
const root = process.cwd(), data = path.join(root, '.test-data', 'project-directory-ui-' + Date.now());
const application = path.join(data, 'app'), store = path.join(data, 'store');
await fs.mkdir(store, { recursive: true });
await fs.cp(path.join(root, 'dist/user'), application, { recursive: true });
// Missing explicit paths prevent discovery or execution of the user's actual CLIs.
const testSettings = { ...offlineSettings(), connections: [], providerPaths: { codex: path.join(data, 'missing-codex'), cursor: path.join(data, 'missing-cursor') }, lastWorkspace: '' };
await fs.writeFile(path.join(store, 'settings.json'), JSON.stringify(testSettings));
await fs.mkdir(path.join(store, 'instances/2'), { recursive: true });
await fs.writeFile(path.join(store, 'instances/2/settings.json'), JSON.stringify({ connections: [], providerPaths: testSettings.providerPaths, lastWorkspace: '' }));
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
const errors = []; let app;
const launch = async () => {
  app = await electron.launch({ args: ['--disable-gpu', application], cwd: root, env, timeout: 60000 });
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByRole('heading', { name: '登录团队工作台', exact: true })).toBeVisible();
  await expect(page.getByLabel('代码目录（选填）')).toHaveCount(0);
  await page.locator('.modal').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible())), false);
  return page;
};
try {
  let page = await launch();
  const prompt = page.getByRole('dialog', { name: '设置项目代码目录', exact: true });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: '暂不设置', exact: true }).click(); await expect(prompt).toHaveCount(0);
  const snapshot = await page.evaluate(() => window.workbench.call('snapshot'));
  const profile = snapshot.settings.workspaceSnapshot.profile;
  const key = JSON.stringify([profile.mode || 'sftp', profile.host, profile.port, profile.localRoot || '', profile.username, profile.fingerprint, offlineProjectId]);
  assert.equal(snapshot.settings.projectDirectories[key], '');
  await app.close(); app = undefined; page = await launch();
  await expect(page.getByRole('dialog', { name: '设置项目代码目录', exact: true })).toHaveCount(0);
  await page.getByTitle('新建会话', { exact: true }).click();
  const session = page.locator('.modal').filter({ hasText: '新建工作会话' });
  await expect(session.getByLabel('绑定共享项目')).toHaveCount(0);
  await expect(session.getByLabel('代码目录（选填）')).toHaveCount(0);
  await session.getByRole('button', { name: '取消', exact: true }).click();

  const originalMain = await fs.readFile(path.join(application, 'main.cjs'), 'utf8');
  const originalAssets = new URL(page.url()).pathname.match(/assets\/[^/]+/)?.[0]; assert(originalAssets);
  const changed = await publishRuntimeAssets(application, { 'index.html': '<h1>incompatible future UI</h1>', 'renderer.js': '', 'renderer.css': '', 'preload.cjs': '' });
  await fs.writeFile(path.join(application, 'main.cjs'), originalMain.replaceAll(originalAssets, changed));
  await fs.writeFile(path.join(application, 'index.html'), '<h1>incompatible future UI</h1>');
  await page.reload();
  await expect(page.getByRole('heading', { name: '登录团队工作台', exact: true })).toBeVisible();
  assert(new URL(page.url()).pathname.includes(originalAssets));
  const additional = app.waitForEvent('window');
  await page.evaluate(() => window.workbench.call('window.new'));
  const next = await additional;
  await expect(next.getByRole('heading', { name: '登录团队工作台', exact: true })).toBeVisible();
  assert(new URL(next.url()).pathname.includes(originalAssets), 'additional account windows must match their running main process');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible())), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, data, cases: ['skip via production IPC', 'skip survives restart', 'no login/session directory fields', 'reload after rebuild keeps matching UI', 'additional window after rebuild keeps matching UI'], visibleWindows: 0, actualCLIs: 0 }));
} finally { if (app) await app.close(); }
