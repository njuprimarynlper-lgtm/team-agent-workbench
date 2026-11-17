import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
const root = process.cwd(), data = path.join(root, '.test-data', 'logging-ui-' + Date.now());
const builtRoot = path.resolve(process.argv.find(value => value.startsWith('--dist='))?.slice(7) || 'dist');
const output = path.join(root, 'artifacts', 'logging'); await fs.mkdir(output, { recursive: true });
const cli = await authLauncher(path.join(data, 'cli'), { status: 'ready', turn: 'success', nativeHistory: true });
const reports = [];
for (const edition of ['user', 'admin']) {
  const directory = path.join(data, edition); await fs.mkdir(directory, { recursive: true });
  if (edition === 'user') {
    const settings = { connections: [], providerPaths: { codex: cli.launcher, cursor: cli.launcher, claude: cli.launcher }, lastWorkspace: '' };
    for (const location of ['personal', 'window-state/1']) { await fs.mkdir(path.join(directory, location), { recursive: true }); await fs.writeFile(path.join(directory, location, 'settings.json'), JSON.stringify(settings)); }
  }
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: directory, WORKBENCH_ADMIN_DATA_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(builtRoot, edition)], cwd: root, env, timeout: 60000 });
  try {
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    if (edition === 'user') {
      await page.waitForLoadState('domcontentloaded');
      await Promise.race([page.getByRole('button', { name: '跳过', exact: true }).waitFor(), page.getByRole('button', { name: '更多功能', exact: true }).waitFor()]);
      if (await page.getByRole('button', { name: '跳过', exact: true }).isVisible()) await page.getByRole('button', { name: '跳过', exact: true }).click();
      await page.getByRole('button', { name: '更多功能', exact: true }).click(); await page.getByRole('menuitem', { name: /日志与分析/ }).click();
    }
    else await page.getByRole('button', { name: '日志与分析', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '日志与分析', exact: true }); await expect(panel).toBeVisible();
    await panel.getByText('日志用量与存储状态', { exact: true }).click();
    await expect(panel.getByText('完整执行轨迹', { exact: true }).first()).toBeVisible();
    await expect(panel.getByText(/30.0 MiB/)).toBeVisible(); await expect(panel.getByText(/20.0 MiB/)).toBeVisible();
    await app.evaluate(({ dialog }, output) => { globalThis.__logExportTarget = output; dialog.showSaveDialog = async () => ({ canceled: false, filePath: globalThis.__logExportTarget }); dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }, path.join(output, edition + '-diagnostic.zip'));
    await page.evaluate(async edition => {
      const api = edition === 'user' ? window.workbench : window.admin;
      await api.call('FIXTURE_UNKNOWN_OPERATION').catch(() => {});
      window.dispatchEvent(new ErrorEvent('error', { message: 'FIXTURE_RENDERER_ERROR token=NEVER_EXPORT_TOKEN', error: new Error('FIXTURE_RENDERER_ERROR token=NEVER_EXPORT_TOKEN') }));
    }, edition);
    await expect.poll(async () => { const names = await fs.readdir(path.join(directory, 'logs')).catch(() => []); let text = ''; for (const name of names) if (name.endsWith('.jsonl')) text += await fs.readFile(path.join(directory, 'logs', name), 'utf8'); return text; }, { timeout: 10000 }).toContain('renderer.error');
    await panel.getByRole('button', { name: '导出故障报告', exact: true }).click(); await expect(panel.getByRole('status')).toContainText('报告已保存');
    await app.evaluate((_, target) => { globalThis.__logExportTarget = target; }, path.join(output, edition + '-workflow.zip'));
    await panel.getByText('更多日志操作', { exact: true }).click(); await panel.getByRole('button', { name: '导出工作流分析包', exact: true }).click(); await expect(panel.getByRole('status')).toContainText(edition + '-workflow.zip');
    await page.screenshot({ path: path.join(output, edition + '.png') });
    await panel.getByRole('button', { name: '清理普通日志', exact: true }).click(); await expect(panel.getByRole('status')).toContainText('日志已清理');
    await panel.getByRole('button', { name: '关闭', exact: true }).click(); await expect(panel).toHaveCount(0); assert.deepEqual(errors, []);
    reports.push({ edition, passed: true });
  } finally { await app.close(); }
}
await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ reports, data }, null, 2));
console.log('Logging desktop smoke passed: user/admin entry, renderer errors, exports, budgets, cleanup. ' + output);
