// Click actual message links offline; IPC is recorded without opening apps or accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const output = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-markdown-links-'));
await build({ entryPoints: ['tests/fixtures/markdown-links-ui.tsx'], outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, logLevel: 'silent' });
await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="markdown-links-ui.css"><div id="root"></div><script src="markdown-links-ui.js"></script>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.context().setOffline(true);
  await page.addInitScript(() => { window.workbench = {}; });
  const url = pathToFileURL(path.join(output, 'index.html')).href;
  await page.goto(url);
  const dialog = page.getByRole('dialog');
  const calls = () => page.evaluate(() => window.linkCalls);
  for (const id of ['child', 'closed', 'main']) {
    const view = page.getByTestId(id);
    for (const [label, expected] of [['相对文件', 'docs/report.md#L12'], ['Windows 文件', 'C:/fixture/%E9%AA%8C%E8%AF%81%20%E6%8A%A5%E5%91%8A.md:12'], ['文件 URI', 'file:///C:/fixture/report.md']]) {
      await view.getByRole('link', { name: label, exact: true }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.session-file-preview')).toHaveText('这是文件预览内容');
      assert.deepEqual((await calls()).at(-1), { name: 'session.file.preview', input: { id, path: expected } });
      // Fallback previews must be outside scroll containers and inline Markdown paragraphs.
      assert.equal(await dialog.evaluate(el => !!el.closest('.markdown')), false);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    }
  }
  const view = page.getByTestId('child');
  for (const label of ['网站', '省略协议', 'www 网站']) {
    const link = view.getByRole('link', { name: label, exact: true });
    await link.focus(); await page.keyboard.press('Enter');
    await expect.poll(async () => (await calls()).at(-1)).toEqual({ name: 'open.link', input: label === 'www 网站' ? 'https://www.example.com/report' : 'https://example.com/report' });
  }
  await view.getByRole('link', { name: '打开失败', exact: true }).click();
  await expect(view.getByRole('alert')).toContainText('默认浏览器无法启动');
  await view.getByRole('button', { name: '关闭链接提示' }).click();
  await expect(view.getByRole('alert')).toHaveCount(0);

  for (const [label, index] of [['第一节', 0], ['第二节', 1]]) {
    await view.getByRole('link', { name: label, exact: true }).click();
    await expect(view.getByRole('heading', { name: '测试标题', exact: true }).nth(index)).toBeFocused();
  }
  const before = (await calls()).length;
  for (const [label, reason] of [['不存在的标题', '未找到'], ['另一条消息标题', '未找到'], ['脚本链接', '不受支持'], ['沙箱链接', '不受支持'], ['空链接', '不受支持'], ['无效网址', '不受支持']]) {
    await view.getByText(label, { exact: true }).click();
    await expect(view.getByRole('alert')).toContainText(reason);
    await view.getByRole('button', { name: '关闭链接提示' }).click();
  }
  assert.equal((await calls()).length, before, 'unsupported/fragment links must not reach file or shell IPC');
  await view.locator('a[data-footnote-ref]').click();
  await expect(view.locator('li[id$="fn-1"]')).toBeFocused();
  await view.locator('a[data-footnote-backref]').click();
  await expect(view.locator('a[data-footnote-ref]')).toBeFocused();

  await page.getByTestId('no-session').getByRole('link', { name: '相对文件', exact: true }).click();
  await expect(page.getByTestId('no-session').getByRole('alert')).toContainText('所属会话');
  assert.equal((await calls()).length, before);
  await view.getByRole('link', { name: '文件不存在', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('文件不存在或已移动');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByTestId('remote').getByRole('link', { name: '相对文件', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('远程主机');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '打开真实历史窗口' }).click();
  const history = page.getByRole('dialog', { name: /已关闭会话/ });
  const historyLink = history.getByRole('link', { name: '相对文件', exact: true });
  await historyLink.click();
  const preview = page.getByRole('dialog', { name: '报告.md', exact: true });
  await expect(preview.locator('.session-file-preview')).toHaveText('这是文件预览内容');
  assert.deepEqual((await calls()).at(-1), { name: 'session.file.preview', input: { id: 'history', path: 'docs/report.md#L12' } });
  await expect(preview.getByRole('button', { name: '关闭窗口', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(preview.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(preview.getByRole('button', { name: '关闭窗口', exact: true })).toBeFocused();
  await page.screenshot({ path: path.join(output, 'history-file.png') });
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(history).toBeVisible();
  await expect(historyLink).toBeFocused();
  await history.getByRole('button', { name: '关闭历史会话窗口' }).click();
  await view.getByRole('link', { name: '网站', exact: true }).click({ button: 'middle' });
  await expect.poll(async () => (await calls()).at(-1)).toEqual({ name: 'open.link', input: 'https://example.com/report' });
  assert.equal(page.url(), url, 'message links must not navigate the app');
  assert.equal(page.context().pages().length, 1);
  assert.deepEqual(errors, []);
  await view.getByRole('link', { name: '打开失败', exact: true }).click();
  await expect(view.getByRole('alert')).toContainText('默认浏览器无法启动');
  await view.screenshot({ path: path.join(output, 'links.png') });
  console.log('Markdown link click checks passed; screenshot: ' + path.join(output, 'links.png'));
} finally { await browser.close(); }
