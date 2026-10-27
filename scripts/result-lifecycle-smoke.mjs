// Real renderer with in-memory fixture APIs only; offline browser, no user stores.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-result-lifecycle-'));
await build({ entryPoints: ['tests/fixtures/result-lifecycle-ui.tsx'], outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, logLevel: 'silent' });
await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="result-lifecycle-ui.css"><div id="root"></div><script src="result-lifecycle-ui.js"></script>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.context().setOffline(true); await page.addInitScript(() => { window.workbench = {}; });
  const url = pathToFileURL(path.join(output, 'index.html')).href;
  await page.goto(url); const card = page.locator('.result-card'); await expect(card).toHaveCount(1);
  await card.locator('summary').click();
  for (const name of ['编辑成果', '修改自己的提交', '标记完成', '修改分类', '删除团队成果', '批量删除']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '设置本地别名', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '检查本地成果删除' }).click(); await page.getByRole('button', { name: '删除成果', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '删除项目成果？' }); await expect(dialog.getByRole('button', { name: '仅删除本地' })).toBeEnabled(); await expect(dialog.getByRole('button', { name: '同时删除团队成果' })).toBeEnabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.action === 'conclusion.deleteMany').length), 0);
  await page.getByRole('button', { name: '删除成果', exact: true }).click(); await page.getByRole('button', { name: '同时删除团队成果', exact: true }).click();
  const sync = await page.evaluate(() => window.fixtureCalls.find(call => call.action === 'conclusion.deleteMany').payload); assert.equal(sync.syncTeam, true); assert.equal(sync.publications[0].revision, 2); assert.equal(sync.publications[0].contentId, '22222222-2222-4222-8222-222222222222');
  for (const state of ['error', 'missing']) {
    await page.goto(url + '?state=' + state); await page.getByRole('button', { name: '检查本地成果删除' }).click(); await page.getByRole('button', { name: '删除成果', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '删除项目成果？' }); await expect(dialog.getByText(state === 'error' ? /无法查询团队成果：网络断开/ : /团队中的原成果已不存在/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: '同时删除团队成果' })).toHaveCount(0); await expect(dialog.getByRole('button', { name: '仅删除本地' })).toBeEnabled();
    await page.screenshot({ path: path.join(output, state + '.png'), fullPage: true }); await dialog.getByRole('button', { name: '仅删除本地' }).click();
    assert.equal(await page.evaluate(() => window.fixtureCalls.find(call => call.action === 'conclusion.deleteMany').payload.syncTeam), false);
  }
  assert.deepEqual(errors, []); console.log('Result lifecycle renderer checks passed: ' + output);
} finally { await browser.close(); }
