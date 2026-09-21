import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { adminServer } from '../tests/fixtures/admin-server.mjs';

const data = path.resolve('.test-data', 'server-upgrade-' + Date.now()); await fs.mkdir(data, { recursive: true });
const server = await adminServer(), errors = [];
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_ADMIN_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
let app, page;
try {
  app = await electron.launch({ args: ['dist/admin'], cwd: process.cwd(), env }); page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.locator('.modal').waitFor();
  await page.evaluate(profile => window.admin.call('connect', { profile, password: 'test-password', sudoPassword: '' }), server.profile);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '更新服务端功能', exact: true }).click();
  await expect(page.locator('.modal')).toContainText('已有账号、共享内容和任务保留');
  await page.getByRole('button', { name: '取消', exact: true }).click(); assert(!server.requests.some(request => request.op === 'storage_upgrade'));
  await page.getByRole('button', { name: '更新服务端功能', exact: true }).click();
  await page.getByRole('button', { name: '确认更新', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  assert.equal(server.requests.filter(request => request.op === 'storage_upgrade').length, 1); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(data, 'updated.png') }); console.log(JSON.stringify({ passed: true, data, cases: ['compressed administrator program sent over SSH stdin', 'cancel does not upgrade', 'explicit upgrade succeeds without changing members'] }));
} catch (error) { if (page && !page.isClosed()) await page.screenshot({ path: path.join(data, 'failure.png') }).catch(() => {}); console.error('Artifacts:', data); throw error; }
finally { await app?.close().catch(() => {}); await server.close(); }
