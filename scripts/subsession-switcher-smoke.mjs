// Offline real-component navigation checks; no desktop app, CLI, account or server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const output = path.resolve('.test-data/subsession-switcher');
await fs.mkdir(output, { recursive: true });
await build({ entryPoints: ['tests/fixtures/subsession-switcher-ui.tsx'], outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', logLevel: 'silent' });
await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="subsession-switcher-ui.css"><div id="root"></div><script src="subsession-switcher-ui.js"></script></html>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().setOffline(true); await page.goto(pathToFileURL(path.join(output, 'index.html')).href);
  const tabs = page.locator('.subsession-tabs'), selected = tabs.locator('[aria-selected="true"]'), input = page.getByRole('textbox', { name: '子会话输入', exact: true });
  const assertActionsRight = async (count, scenario) => {
    const metrics = await page.locator('.subsession-composer .composer-bottom').evaluate(el => {
      const bar = el.getBoundingClientRect(), style = getComputedStyle(el);
      return { left: bar.left + parseFloat(style.paddingLeft), right: bar.right - parseFloat(style.paddingRight), buttons: [...el.querySelectorAll('button.send')].map(button => { const r = button.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: r.width }; }) };
    });
    assert.equal(metrics.buttons.length, count, scenario);
    assert(Math.abs(metrics.right - metrics.buttons.at(-1).right) <= 1, `${scenario}: action group is not right-aligned: ${JSON.stringify(metrics)}`);
    assert(metrics.buttons.every(button => button.left >= metrics.left && button.right <= metrics.right + 1 && button.width >= 30), scenario + ': action is clipped or squeezed');
    assert(metrics.buttons.every(button => Math.abs(button.top - metrics.buttons[0].top) <= 1), scenario + ': send and stop must stay on the same row');
  };
  // Test panel width independently of viewport width: the old spacer collapsed
  // above the global 1250px breakpoint even in a narrow right-hand child pane.
  for (const [viewport, pane] of [[1600, 720], [1600, 340], [1300, 440], [1100, 340]]) {
    await page.setViewportSize({ width: viewport, height: 900 });
    await page.getByLabel('右栏宽度').fill(String(pane));
    for (const long of [false, true]) {
      await page.getByLabel('长模型名称').setChecked(long);
      for (const state of ['idle', 'running', 'starting', 'approval', 'stopping']) {
        await page.getByLabel('子会话状态').selectOption(state);
        await assertActionsRight(state === 'idle' ? 1 : 2, `${viewport}/${pane}, long=${long}, ${state}`);
      }
    }
  }
  await page.screenshot({ path: path.join(output, 'composer-actions-narrow.png') });
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.getByLabel('右栏宽度').fill('440');
  await page.getByLabel('长模型名称').uncheck();
  await page.getByLabel('子会话状态').selectOption('idle');
  await expect(tabs.getByRole('tab')).toHaveCount(2); await expect(selected).toHaveText('误差分析');
  await expect(tabs).not.toContainText('已关闭'); await expect(tabs).not.toContainText('版面分析');
  await input.fill('误差分析的未发送草稿'); await tabs.getByRole('tab', { name: '速度验证', exact: false }).click();
  await expect(input).toHaveValue(''); await input.fill('速度验证的独立草稿');
  await expect(page.getByRole('button', { name: '停止当前任务', exact: true })).toBeVisible();
  await tabs.getByRole('tab', { name: '速度验证', exact: false }).press('ArrowLeft');
  await expect(selected).toHaveText('误差分析'); await expect(selected).toBeFocused();
  await expect(input).toHaveValue('误差分析的未发送草稿');
  await tabs.getByRole('tab', { name: '速度验证', exact: false }).click(); await expect(input).toHaveValue('速度验证的独立草稿');
  await expect(page.locator('#fixture-calls')).toHaveText('');
  await page.getByRole('button', { name: '展开会话菜单：OCR 识别优化', exact: true }).click();
  await page.locator('[data-session-id="b2"]').click();
  await expect(tabs.getByRole('tab')).toHaveText(['版面分析', '识别准确率']); await expect(selected).toHaveText('识别准确率');
  await expect(page.locator('#main-parent')).toHaveText('OCR 识别优化'); await expect(input).toHaveValue('');
  await tabs.getByRole('tab', { name: '版面分析', exact: true }).click(); await expect(selected).toHaveText('版面分析');
  await page.locator('[data-session-id="a"]').click(); await expect(tabs.getByRole('tab')).toHaveCount(2); await expect(selected).toHaveText('误差分析');
  await expect(input).toHaveValue('误差分析的未发送草稿');
  await page.locator('.subsession-child-list > summary').click();
  await page.getByRole('navigation', { name: '下级子会话' }).getByRole('button', { name: '分块实验' }).click();
  await expect(tabs.getByRole('tab')).toHaveText(['分块实验', '尾部样本']);
  await expect(tabs).toHaveAttribute('aria-label', '父会话「误差分析」的子会话');
  await page.getByRole('button', { name: '← 误差分析', exact: true }).click(); await expect(selected).toHaveText('误差分析');
  await page.screenshot({ path: path.join(output, 'siblings.png') });
  await page.getByRole('button', { name: '增加同级子会话' }).click();
  await page.getByLabel('右栏宽度').fill('340'); await expect(tabs.getByRole('tab')).toHaveCount(12);
  const next = page.getByRole('button', { name: '查看后面的子会话', exact: true });
  await expect(next).toBeEnabled(); await next.click();
  await expect(page.getByRole('button', { name: '查看前面的子会话', exact: true })).toBeEnabled();
  await selected.focus(); await selected.press('End');
  await expect(selected).toHaveText('比较不同规模下的长标题探索方案 10'); await expect(selected).toBeFocused();
  await expect(next).toBeDisabled();
  const geometry = await tabs.evaluate(el => ({ height: el.clientHeight, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, current: (() => { const rect = el.querySelector('[aria-selected="true"]').getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width }; })(), tops: [...el.children].map(child => child.getBoundingClientRect().top) }));
  assert(geometry.height <= 32); assert.equal(new Set(geometry.tops).size, 1);
  assert(geometry.current.width <= 150); assert(geometry.current.left >= geometry.left - 1 && geometry.current.right <= geometry.right + 1);
  await page.screenshot({ path: path.join(output, 'overflow.png') });
  await page.locator('[data-session-id="b"]').click(); await expect(tabs.getByRole('tab')).toHaveCount(2); await expect(next).toHaveCount(0);
  await page.locator('[data-session-id="empty"]').click(); await expect(tabs).toHaveCount(0); await expect(input).toHaveCount(0);
  assert.deepEqual(errors, []); await expect(page.locator('#fixture-calls')).toHaveText('');
  console.log('PASS: direct sibling groups, cross-parent replacement, parent selection, nested groups, independent drafts, no execution calls, closed filtering, keyboard focus, and compact overflow. ' + output);
} finally { await browser.close(); }
