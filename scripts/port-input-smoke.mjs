// Isolated real renderers; never connect to a server or modify the user's settings.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';

const root = process.cwd(), build = await fs.realpath(process.env.WORKBENCH_TEST_BUILD_ROOT || path.join(root, 'dist'));
await fs.mkdir(path.join(root, '.test-data'), { recursive: true });
const data = await fs.mkdtemp(path.join(root, '.test-data', 'port-input-')), errors = [];
async function editing(field, submit) {
  await field.fill('22'); await field.press('End'); await field.press('Backspace'); await field.press('Backspace');
  await expect(field).toHaveValue('');
  if (submit) await expect(submit).toBeDisabled();
  await field.pressSequentially('2222'); await expect(field).toHaveValue('2222');
  for (const value of ['0', '65536']) {
    await field.fill(value); await expect(field).toHaveValue(value); await expect(field).toHaveAttribute('aria-invalid', 'true');
    if (submit) await expect(submit).toBeDisabled();
  }
  for (const value of ['1', '65535', '22']) {
    await field.fill(value); await expect(field).toHaveValue(value); await expect(field).toHaveAttribute('aria-invalid', 'false');
    if (submit) await expect(submit).toBeEnabled();
  }
  await field.fill(''); await field.pressSequentially('3.5e-'); await expect(field).toHaveValue('35');
  await field.fill(''); await expect(field).toHaveValue('');
}
for (const edition of ['user', 'admin']) {
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: path.join(data, 'user'), WORKBENCH_ADMIN_DATA_DIR: path.join(data, 'admin') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(build, edition)], cwd: root, env, timeout: 60000 });
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    if (edition === 'user') {
      await page.locator('.central-node-trigger').click();
      await page.getByLabel('中央节点地址', { exact: true }).fill('127.0.0.1');
      await page.getByLabel('成员账号', { exact: true }).fill('fixture');
      await page.getByLabel('登录密码', { exact: true }).fill('synthetic-not-sent');
      await editing(page.getByLabel('SFTP 端口', { exact: true }), page.getByRole('button', { name: '连接并查看项目', exact: true }));
      await page.getByLabel('SFTP 端口', { exact: true }).press('Enter');
      assert.equal((await page.evaluate(() => window.workbench.call('snapshot'))).connection, undefined);
    } else {
      await page.getByLabel('服务器地址', { exact: true }).fill('127.0.0.1');
      await page.getByLabel('管理账号', { exact: true }).fill('fixture');
      await page.getByLabel('登录密码', { exact: true }).fill('synthetic-not-sent');
      await editing(page.getByLabel('SSH 端口', { exact: true }), page.getByRole('button', { name: '连接并验证权限', exact: true }));
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await page.getByRole('button', { name: '网络出口', exact: true }).click();
      await page.getByRole('tab', { name: '出口设置', exact: true }).click();
      await editing(page.getByLabel('网络出口端口', { exact: true }));
      await page.getByRole('button', { name: '保存并应用', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('1–65535');
    }
  } finally { await app.close(); }
}
assert.deepEqual(errors, []);
console.log('Port input UI passed: user/admin clear, retype, range validation, empty-submit protection and egress.');
