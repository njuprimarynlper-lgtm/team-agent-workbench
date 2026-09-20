import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const data = path.join(root, '.test-data', 'egress-ui-' + Date.now());
const store = path.join(data, 'admin');
await fs.mkdir(store, { recursive: true });
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_ADMIN_DATA_DIR: store };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const errors = [];
try {
  app = await electron.launch({ args: ['dist/admin'], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '网络出口', exact: true }).click();
  await expect(page.getByRole('heading', { name: '网络出口', exact: true })).toBeVisible();
  await expect(page.getByText('未启用', { exact: true })).toBeVisible();
  await expect(page.getByLabel('提供给成员的地址')).not.toHaveValue('');
  await expect(page.getByLabel('网络出口端口')).toHaveValue('18443');
  await expect(page.getByLabel('上游代理类型')).toHaveValue('direct');
  await expect(page.getByText('用户端接入码', { exact: true })).toBeVisible();
  await expect(page.getByText('仅记录用户端上报的账号标识、产品、目标域名和流量，不保存提问、回答或个人账号凭据；账号标识不用于权限认证。', { exact: true })).toBeVisible();
  const first = await page.evaluate(() => window.admin.call('snapshot'));
  assert.equal(first.egress.config.enabled, false);
  assert.match(first.egress.inviteCode, /^TAE1\./);
  assert.match(first.egress.fingerprint, /^[A-F0-9]{64}$/);
  await page.getByLabel('启用管理端出口').check();
  await page.getByLabel('提供给成员的地址').fill('127.0.0.1');
  await page.getByLabel('网络出口端口').fill('18444');
  await page.getByRole('button', { name: '保存并应用', exact: true }).click();
  await expect(page.getByText('网络出口已保存并启动', { exact: true })).toBeVisible();
  await expect(page.getByText('出口运行中', { exact: true })).toBeVisible();
  const running = await page.evaluate(() => window.admin.call('snapshot'));
  assert.equal(running.egress.running, true);
  assert.equal(running.egress.config.publicHost, '127.0.0.1');
  await page.getByRole('button', { name: '更新接入码', exact: true }).click();
  await expect(page.getByText('接入码已更新，已接入成员需要重新配置', { exact: true })).toBeVisible();
  const rotated = await page.evaluate(() => window.admin.call('snapshot'));
  assert.notEqual(rotated.egress.inviteCode, running.egress.inviteCode);
  assert.equal(rotated.egress.running, true);
  await page.getByLabel('启用管理端出口').uncheck();
  await page.getByRole('button', { name: '保存并应用', exact: true }).click();
  await expect(page.getByText('网络出口已关闭，用户端可继续使用本机直连', { exact: true })).toBeVisible();
  const stopped = await page.evaluate(() => window.admin.call('snapshot'));
  assert.equal(stopped.egress.running, false);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(data, 'network-egress.png') });
  console.log(JSON.stringify({ passed: true, data, cases: ['admin egress is independent of shared-space login', 'certificate and invitation are generated automatically', 'direct upstream is the default', 'relay starts and stops from the graphical page', 'rotating the invitation restarts the relay and invalidates the previous code', 'connection metadata privacy is explained'] }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(data, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
}
