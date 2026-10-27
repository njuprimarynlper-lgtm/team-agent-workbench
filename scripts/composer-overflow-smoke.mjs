// Offline real-component test. No desktop app, model, account or remote server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { expectComposerReference, openComposerReferences } from './composer-reference-smoke.mjs';

const output = path.resolve('.test-data/composer-overflow');
await fs.mkdir(output, { recursive: true });
await build({ entryPoints: ['tests/fixtures/composer-overflow-ui.tsx'], outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', logLevel: 'silent' });
await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="composer-overflow-ui.css"><div id="root"></div><script src="composer-overflow-ui.js"></script></html>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 740 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.context().setOffline(true); await page.goto(pathToFileURL(path.join(output, 'index.html')).href);
  const more = page.locator('.composer-reference-more'), tabs = page.locator('.composer-reference-tab'), panel = page.locator('.composer-reference-panel');
  await expect(page.locator('.session-sync-tab')).toBeVisible(); await expect(more).toHaveCount(0); await expect(tabs).toHaveCount(0);
  await page.getByRole('button', { name: '1 份资料', exact: true }).click(); await expect(tabs).toHaveCount(1); await expect(more).toHaveCount(0);
  await expectComposerReference(page, '参考资料 1');
  await page.getByRole('button', { name: '3 份资料', exact: true }).click(); await expect(tabs).toHaveCount(3); await expect(more).toHaveCount(0);
  const screenshot = async name => {
    const box = await page.locator('.session-sync-frame').boundingBox(); assert(box);
    await page.screenshot({ path: path.join(output, name), clip: { x: box.x, y: box.y - 26, width: box.width, height: box.height + 26 } });
  };
  await screenshot('all-visible.png');
  await page.getByLabel('输入区宽度').fill('420'); await expect(more).toBeVisible(); await expect(tabs).toHaveCount(1);
  await expect(more).toHaveText('更多 2');
  await screenshot('overflow.png');
  await more.focus(); await more.press('Enter'); await expect(panel).toBeVisible(); await expect(panel.locator('.composer-reference-row')).toHaveCount(3);
  await more.press('Escape'); await expect(panel).toHaveCount(0); await expect(more).toBeFocused();
  await more.click();
  // Resize while the popup is open, without an outside click dismissing it first.
  await page.evaluate(() => { const root = document.querySelector('.composer-wrap'); root.style.width = '900px'; });
  await expect(more).toHaveCount(0); await expect(tabs).toHaveCount(3); await expect(panel).toHaveCount(0); await expect(tabs.first()).toBeFocused();
  await page.getByLabel('输入区宽度').fill('421'); await expect(more).toBeVisible();
  await openComposerReferences(page);
  // Removing one item makes the remaining two fit; the menu and More both disappear.
  await panel.getByRole('button', { name: '撤销加入：参考资料 3', exact: true }).click();
  await expect(more).toHaveCount(0); await expect(tabs).toHaveCount(2); await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: '8 份资料', exact: true }).click(); await expect(more).toBeVisible();
  await page.getByRole('button', { name: '仅留一份', exact: true }).click(); await expect(more).toHaveCount(0); await expect(tabs).toHaveCount(1);
  await page.getByRole('button', { name: '0 份资料', exact: true }).click(); await expect(more).toHaveCount(0); await expect(tabs).toHaveCount(0);
  await page.getByRole('textbox', { name: '会话草稿' }).fill('仍然保留我的输入');
  await page.getByRole('button', { name: '1 份资料', exact: true }).click(); await expect(tabs).toHaveCount(1); await expect(more).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '会话草稿' })).toHaveValue('仍然保留我的输入');
  await page.getByRole('button', { name: '连续更新项目说明', exact: true }).click();
  await expect(tabs).toHaveCount(1); await expect(tabs).toHaveText(['项目说明 · v3']); await expect(more).toHaveCount(0);
  await tabs.click(); await expect(panel.getByRole('checkbox')).toBeChecked(); await expect(panel.getByRole('checkbox')).toBeDisabled();
  await page.keyboard.press('Escape'); await screenshot('project-brief-latest.png');
  await page.getByRole('button', { name: '确认已发送', exact: true }).click();
  await expect(tabs).toHaveCount(0); await expect(more).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '会话草稿' })).toHaveValue('仍然保留我的输入');
  assert.deepEqual(errors, []);
  console.log('PASS: empty/fitting/overflow rows, dynamic resize, removal, popup dismissal/focus, keyboard, preview, project brief replacement, and draft preservation. ' + output);
} finally { await browser.close(); }
