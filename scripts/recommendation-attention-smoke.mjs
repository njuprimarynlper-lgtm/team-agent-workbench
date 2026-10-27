// Offline, headless UI verification; no desktop, account, model or server is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
const output = path.resolve('.test-data/recommendation-attention');
await fs.mkdir(output, { recursive: true });
await build({ entryPoints: ['tests/fixtures/recommendation-attention-ui.tsx'], outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', logLevel: 'silent' });
await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="recommendation-attention-ui.css"><div id="root"></div><script src="recommendation-attention-ui.js"></script></html>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 730 }, timezoneId: 'Asia/Shanghai' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.context().setOffline(true); await page.addInitScript(() => { window.workbench = { call: async () => { throw new Error('No native IPC allowed'); } }; });
  await page.goto(pathToFileURL(path.join(output, 'index.html')).href);
  const tab = page.locator('#project-ai-tab'), badge = tab.locator('.recommendation-count');
  await expect(tab).not.toHaveClass(/has-pending/); await expect(badge).toHaveCount(0);
  await page.getByRole('textbox', { name: '求助草稿' }).fill('保留这份草稿');
  await page.getByRole('button', { name: '模拟收到推荐', exact: true }).click();
  await expect(tab).toHaveClass(/has-pending/); await expect(badge).toHaveText('3待处理');
  await expect(page.locator('#project-questions-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: '求助草稿' })).toHaveValue('保留这份草稿');
  await page.locator('.project-interaction-shell').screenshot({ path: path.join(output, 'expanded-pending.png') });
  await tab.click(); await expect(badge).toHaveText('3待处理'); // Reading is not a decision.
  await page.getByRole('button', { name: '接受', exact: true }).click();
  await expect(badge).toHaveText('2待处理');
  await page.getByRole('button', { name: '保存补充', exact: true }).click();
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(badge).toHaveText('1待处理');
  await page.getByRole('button', { name: '保存补充', exact: true }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(badge).toHaveCount(0); await expect(tab).not.toHaveClass(/has-pending/);
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const entry = page.getByRole('button', { name: '展开 AI推荐', exact: true });
  await expect(entry).not.toHaveClass(/has-pending/);
  await page.getByRole('button', { name: '模拟收到推荐', exact: true }).click();
  await expect(entry).toHaveClass(/has-pending/); await expect(entry.locator('.recommendation-count')).toHaveText('3');
  await expect(page.locator('#project-interaction-panel')).toBeHidden();
  await expect(entry).toHaveAttribute('title', '3 条推荐待处理，点击查看');
  await page.locator('.project-interaction-shell').screenshot({ path: path.join(output, 'collapsed-pending.png') });
  await page.getByRole('button', { name: '停止后台分析', exact: true }).click();
  await expect(entry.locator('.recommendation-count')).toHaveText('3'); // Existing recommendations are retained.
  await entry.focus(); await entry.press('Enter');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '模拟大量推荐', exact: true }).click();
  await expect(badge).toHaveText('99+待处理'); await expect(badge).toHaveAttribute('title', '120 条推荐待处理');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(entry.locator('.recommendation-count')).toHaveText('99+');
  const bounds = await entry.evaluate(node => { const a = node.getBoundingClientRect(), b = node.querySelector('.recommendation-count').getBoundingClientRect(); return b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom; });
  assert(bounds, 'Large badge must stay within the collapsed rail');
  await entry.click();
  for (const width of [700, 900, 1100]) {
    await page.setViewportSize({ width, height: 730 });
    await expect(tab).toBeVisible();
    assert(await tab.evaluate(node => { const a = node.getBoundingClientRect(), b = node.querySelector('.recommendation-count').getBoundingClientRect(); return b.right <= a.right && b.left >= a.left && b.top >= a.top && b.bottom <= a.bottom; }), 'Tab badge must not clip');
  }
  await page.getByRole('button', { name: '清空推荐', exact: true }).click();
  await expect(tab).not.toHaveClass(/has-pending/); await expect(badge).toHaveCount(0);
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(entry).not.toHaveClass(/has-pending/); await expect(entry.locator('.recommendation-count')).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log('PASS: pending arrival in both sidebar modes, no automatic navigation, draft preserved, reading/accept/reject/close counts, zero-state reset, disabled analysis, 99+ bound, keyboard opening and three widths.');
  console.log(output);
} finally { await browser.close(); }
