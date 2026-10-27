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
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 }, timezoneId: 'Asia/Shanghai' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.context().setOffline(true); await page.addInitScript(() => { window.workbench = {}; });
  await page.goto(pathToFileURL(path.join(output, 'index.html')).href);
  const team = page.locator('[data-project-id="team"]');
  await expect(page.getByRole('switch', { name: 'AI推荐：团队工作台', exact: true })).toBeEnabled();
  await expect(page.locator('.workgroup-project-details')).toHaveCount(1);
  await team.click(); await team.click();
  await expect(page.locator('.workgroup-project-details')).toHaveCount(1);
  await expect(page.locator('.sidebar>.project-session-panel')).toHaveCount(1);
  await expect(page.locator('.workgroup-list .project-session-panel')).toHaveCount(0);
  await expect(team).toHaveAttribute('aria-pressed', 'true');
  assert.equal(await team.getAttribute('aria-expanded'), null, 'Project selection must not toggle a dropdown');
  await expect(team.locator('svg.lucide-square-kanban')).toHaveCount(1);
  await page.locator('[data-project-id="research"]').click();
  await expect(page.locator('.project-session-panel [data-session-id]')).toHaveCount(1);
  await expect(page.locator('.project-session-panel')).toContainText('轨迹采集与评估');
  await expect(page.locator('.session-project-caption')).toHaveText('算法研究与软件落地的跨团队项目名称很长也不换行');
  await page.getByRole('button', { name: '未分组', exact: false }).click();
  await expect(page.locator('.project-session-panel')).toContainText('个人资料阅读');
  await expect(page.locator('.project-session-panel [data-session-id]')).toHaveCount(1);
  await page.locator('[data-project-id="legacy"]').click();
  await expect(page.locator('.project-session-panel')).toContainText('没有打开的会话');
  await expect(page.getByRole('button', { name: '新建会话', exact: true })).toBeVisible();
  await team.click();
  await expect(page.locator('.project-session-panel [data-session-id]')).toHaveCount(2);
  await page.getByRole('button', { name: '中央节点：已连接', exact: true }).click();
  await expect(page.locator('#fixture-notice')).toHaveText('中央节点：团队工作台');
  await page.getByRole('button', { name: '查看AI推荐：团队工作台', exact: true }).click();
  await expect(page.locator('#fixture-notice')).toHaveText('AI推荐：团队工作台');
  const toggle = page.getByRole('switch', { name: 'AI推荐：团队工作台', exact: true });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const settings = page.getByRole('button', { name: '项目设置：旧版本本机项目', exact: true });
  await settings.focus(); await expect(settings).toHaveCSS('opacity', '1');
  await settings.press('Enter'); await expect(page.locator('#fixture-notice')).toHaveText('项目设置：旧版本本机项目');
  await expect(page.locator('.project-session-panel')).toHaveCount(1);
  await expect(page.locator('[data-project-id="team"]').locator('..').locator('.project-session-count')).toHaveText('2');
  const session = page.locator('[data-session-id="alternative"]');
  await session.dblclick(); await page.getByRole('textbox', { name: '会话名称', exact: true }).fill('重命名验证');
  await page.getByRole('textbox', { name: '会话名称', exact: true }).press('Enter'); await expect(session).toContainText('重命名验证');
  await session.click({ button: 'right' }); await page.getByRole('menuitem', { name: '关闭会话', exact: true }).click();
  await expect(session).toHaveCount(0); await expect(page.locator('[data-project-id="team"]').locator('..').locator('.project-session-count')).toHaveText('1');
  await expect(page.getByRole('button', { name: '已关闭会话（1）', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开会话菜单：量化转换方案比较', exact: true }).click();
  await page.getByRole('button', { name: '＋ 创建子会话', exact: true }).click(); await expect(page.locator('#fixture-notice')).toContainText('创建子会话：');
  await page.getByRole('button', { name: '展开会话菜单：量化转换方案比较', exact: true }).click();
  await expect(page.locator('.conversation-user-time time')).toContainText('2026/10/27');
  await expect(page.locator('.conversation-message.assistant time')).toContainText('2026/10/27');
  const summary = page.locator('.turn-timing-summary');
  await expect(summary.locator('summary')).toContainText('已思考 18 秒 · 整轮用时 42 秒');
  await summary.locator('summary').click(); await expect(summary.locator('dl')).toContainText('工具执行'); await expect(summary.locator('dl')).toContainText('14 秒');
  await page.getByRole('button', { name: '开始计时', exact: true }).click();
  await expect(page.locator('.turn-progress-clock')).toContainText('0 秒');
  await expect(page.locator('.turn-progress-clock')).not.toHaveText('0 秒 · 思考 0 秒', { timeout: 4000 });
  await page.getByRole('button', { name: '结束计时', exact: true }).click(); await expect(page.locator('.turn-progress')).toHaveCount(0);
  await page.getByRole('button', { name: '大量推荐', exact: true }).click();
  for (const width of [220, 262, 320]) {
    await page.locator('.sidebar').evaluate((node, width) => node.style.width = width + 'px', width);
    for (const id of ['team', 'research', 'legacy']) {
      const button = page.locator(`[data-project-id="${id}"]`);
      if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
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
  await page.getByRole('button', { name: '切换大量会话', exact: true }).click();
  await team.click();
  for (const height of [600, 720, 980]) {
    await page.setViewportSize({ width: 1100, height });
    for (const projectHeight of [80, 236, 2000]) {
      await page.locator('.workgroup-list').evaluate((node, size) => node.style.height = size + 'px', projectHeight);
      const layout = await page.evaluate(() => {
        const sidebar = document.querySelector('.sidebar'), projects = document.querySelector('.sidebar-project-pane'), panel = document.querySelector('.project-session-panel'), list = panel.querySelector('.session-list');
        const a = sidebar.getBoundingClientRect(), b = projects.getBoundingClientRect(), c = panel.getBoundingClientRect();
        return { panelBelowProjects: c.top >= b.bottom, panelVisible: c.bottom <= a.bottom + 1 && c.height >= 160, sidebarOverflow: sidebar.scrollHeight > sidebar.clientHeight + 1, sessionsScroll: list.scrollHeight > list.clientHeight, projectsScroll: projects.querySelector('.workgroup-list').scrollHeight > projects.querySelector('.workgroup-list').clientHeight };
      });
      assert(layout.panelBelowProjects && layout.panelVisible && !layout.sidebarOverflow, `Separate panes must stay usable at viewport ${height}, saved project height ${projectHeight}`);
      assert(layout.sessionsScroll && layout.projectsScroll, 'Each list scrolls independently');
    }
  }
  const position = await page.locator('.project-session-panel').boundingBox();
  await page.locator('.workgroup-list').evaluate(node => node.scrollTop = node.scrollHeight);
  assert.deepEqual(await page.locator('.project-session-panel').boundingBox(), position, 'Scrolling projects must not move the session pane');
  await page.getByRole('button', { name: '切换大量会话', exact: true }).click();
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.locator('.workgroup-list').evaluate(node => node.style.height = '236px');
  await page.locator('.sidebar').evaluate(node => node.style.width = '262px'); await team.click();
  await page.locator('.workgroup-list').evaluate(node => node.scrollTop = 0);
  await page.locator('.sidebar').screenshot({ path: path.join(output, 'sidebar.png') });
  await page.screenshot({ path: path.join(output, 'conversation-and-projects.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: separated project/session selection, counts, rename/close/child actions, date/time, live timer/disclosure, compact rows, three widths, keyboard settings, project connection and AI controls.');
  console.log(path.join(output, 'sidebar.png'));
} finally { await browser.close(); }
