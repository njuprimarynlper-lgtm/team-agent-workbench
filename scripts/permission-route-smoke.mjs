import { _electron as electron, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
import { dismissStartupLogin } from './connection-helpers.mjs';

const expect = baseExpect.configure({ timeout: 25000 });
const root = process.cwd(), data = path.join(root, '.test-data', 'permission-route-' + Date.now());
const store = path.join(data, 'user');
const cli = await authLauncher(path.join(data, 'cli'), { status: 'ready', permissionConfig: { sandbox: 'read-only', approval: 'never' } });
const settings = {
  connections: [], providerPaths: { codex: cli.launcher, cursor: cli.launcher, claude: cli.launcher },
  localWorkspace: data, verifiedLocalWorkspace: data, lastWorkspace: data,
  egress: { enabled: true, viaSharedServer: true, host: 'test.invalid', port: 443, certificateFingerprint: 'A'.repeat(64) },
};
await fs.mkdir(path.join(store, 'window-state', '1'), { recursive: true });
await fs.mkdir(path.join(store, 'personal'), { recursive: true });
await fs.writeFile(path.join(store, 'window-state', '1', 'settings.json'), JSON.stringify(settings));
await fs.writeFile(path.join(store, 'personal', 'settings.json'), JSON.stringify(settings));
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
let app, page;
try {
  app = await electron.launch({ args: ['dist/user'], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow();
  await dismissStartupLogin(page);
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const picker = page.getByLabel('CLI 执行权限');
  await expect(picker).toContainText('此网络方式经中央节点转发，请先连接中央节点');
  await page.getByLabel('通过管理端访问模型服务').uncheck();
  await expect(picker).not.toContainText('权限检测失败');
  await expect(picker).toContainText('已保存设置：自定义设置');
  await page.getByRole('button', { name: '重新检测权限' }).click();
  await expect(picker).toContainText('已保存设置：自定义设置');
  await expect(page.getByRole('button', { name: '创建会话', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新建工作会话' })).toHaveCount(0);
  const snapshot = await page.evaluate(() => window.workbench.call('snapshot'));
  const session = snapshot.sessions.find(item => item.provider === 'codex');
  assert.equal(session?.networkRoute, 'direct');
  await page.getByLabel('当前执行权限').click();
  const dialog = page.getByRole('dialog', { name: '执行权限', exact: true });
  await expect(dialog.getByRole('button', { name: '请求批准', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '刷新选项' }).click();
  await expect(dialog.getByRole('button', { name: '请求批准', exact: true })).toBeEnabled();
  await expect(dialog).not.toContainText('权限读取失败');
  console.log('Permission route UI passed: disconnected management route rejects inspection; new and existing direct sessions inspect locally.');
} finally { await app?.close().catch(() => {}); }
