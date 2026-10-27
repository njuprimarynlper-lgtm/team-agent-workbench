// Offline, headless component fixture. Does not start the workbench or a CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
const output = path.resolve('.test-data/sidebar-projects-verification');
await fs.mkdir(output, { recursive: true });
await build({ entryPoints: ['tests/fixtures/sidebar-projects-ui.tsx'], outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', logLevel: 'silent' });
await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="sidebar-projects-ui.css"><div id="root"></div><script src="sidebar-projects-ui.js"></script>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.context().setOffline(true); await page.addInitScript(() => { window.workbench = {}; });
  await page.goto(pathToFileURL(path.join(output, 'index.html')).href);
  const team = page.locator('[data-project-id="team"]');
  await expect(page.getByRole('switch', { name: 'AI推荐：团队工作台', exact: true })).toBeEnabled();
  await expect(page.locator('.workgroup-project-details')).toHaveCount(1);
  await team.click(); await expect(page.locator('.workgroup-project-details')).toHaveCount(0);
  await team.click(); await expect(page.locator('.workgroup-project-details')).toHaveCount(1);
  await page.getByRole('button', { name: '中央节点：已连接', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('中央节点：团队工作台');
  await page.getByRole('button', { name: '查看AI推荐：团队工作台', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('AI推荐：团队工作台');
  const toggle = page.getByRole('switch', { name: 'AI推荐：团队工作台', exact: true });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const settings = page.getByRole('button', { name: '项目设置：旧版本本机项目', exact: true });
  await settings.focus(); await expect(settings).toHaveCSS('opacity', '1');
  await settings.press('Enter'); await expect(page.getByRole('status')).toHaveText('项目设置：旧版本本机项目');
  await page.getByRole('button', { name: '大量推荐', exact: true }).click();
  for (const width of [220, 262, 320]) {
    await page.locator('.sidebar').evaluate((node, width) => node.style.width = width + 'px', width);
    for (const id of ['team', 'research', 'legacy']) {
      const button = page.locator(`[data-project-id="${id}"]`);
      if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
      const bounds = await page.evaluate(() => {
        const list = document.querySelector('.workgroup-list'), personal = document.querySelector('.personal-section');
        const rows = [...document.querySelectorAll('.workgroup-project-row')].map(node => node.getBoundingClientRect().height);
        const detail = document.querySelector('.workgroup-project-details'), connection = detail.querySelector('.project-connection-entry'), ai = detail.querySelector('.project-ai-row');
        const a = connection.getBoundingClientRect(), b = ai.getBoundingClientRect();
        const title = document.querySelector('.is-selected .workgroup-project>span');
        return { rows, widths: [...document.querySelectorAll('.project-card')].map(node => node.getBoundingClientRect().width), personal: personal.getBoundingClientRect().width,
          overflow: list.scrollWidth > list.clientWidth, horizontalOverlap: a.right > b.left + 1, sameRow: Math.abs(a.top - b.top) < 1,
          titleHeight: title.getBoundingClientRect().height, ellipsis: getComputedStyle(title).textOverflow };
      });
      assert(bounds.rows.every(height => height === 32), 'Project rows must be 32px');
      assert(bounds.widths.every(value => value === bounds.personal), 'Personal and project sections must align');
      assert(!bounds.overflow && !bounds.horizontalOverlap && bounds.sameRow, `Controls must fit at ${width}px for ${id}`);
      assert.equal(bounds.ellipsis, 'ellipsis'); assert(bounds.titleHeight < 25);
    }
  }
  await page.getByRole('button', { name: '切换设置错误', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('暂时无法读取');
  const alert = page.getByRole('alert'); assert((await alert.boundingBox()).height > 20, 'Errors remain readable instead of clipped to a compact row');
  await page.getByRole('button', { name: '切换设置错误', exact: true }).click(); await expect(alert).toHaveCount(0);
  await page.locator('.sidebar').evaluate(node => node.style.width = '262px'); await team.click();
  await page.locator('.workgroup-list').evaluate(node => node.scrollTop = 0);
  await page.locator('.sidebar').screenshot({ path: path.join(output, 'sidebar.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: compact rows, aligned sections, three widths, long names, keyboard settings, collapse, project connection, AI switches, pending counts, and readable errors.');
  console.log(path.join(output, 'sidebar.png'));
} finally { await browser.close(); }
