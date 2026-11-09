import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

for (const edition of ['user', 'admin']) {
  const data = path.resolve('.test-data', 'font-size-' + edition + '-' + Date.now());
  await fs.mkdir(data, { recursive: true });
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: data, WORKBENCH_ADMIN_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['dist/' + edition], cwd: process.cwd(), env, timeout: 60000 });
  try {
    const page = await app.firstWindow();
    const selector = edition === 'user' ? '.topbar strong' : '.admin-brand';
    await page.locator(selector).first().waitFor();
    const sizes = () => page.evaluate(({ selector, edition }) => {
      const result = {
        root: getComputedStyle(document.documentElement).fontSize,
        label: getComputedStyle(document.querySelector(selector)).fontSize,
      };
      if (edition === 'user') {
        const fixture = document.createElement('div');
        fixture.className = 'message';
        fixture.innerHTML = '<div class="markdown"><h1>Title</h1></div>';
        document.body.append(fixture);
        result.heading = getComputedStyle(fixture.querySelector('h1')).fontSize;
        fixture.remove();
      }
      return result;
    }, { selector, edition });
    const initial = await sizes();
    assert.equal(initial.root, '14px');
    const increased = { root: '15px', label: `${Number.parseFloat(initial.label) + 1}px` };
    if (edition === 'user') increased.heading = `${Number.parseFloat(initial.heading) + 1}px`;
    await page.keyboard.press('Control+Equal');
    assert.deepEqual(await sizes(), increased);
    const zoom = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
    assert.equal(zoom, 1, 'the shortcut changes fonts instead of browser zoom');
    await page.reload();
    await page.locator(selector).first().waitFor();
    assert.deepEqual(await sizes(), increased, 'font step survives a reload');
    await page.keyboard.press('Control+Minus');
    assert.deepEqual(await sizes(), initial);
    await page.keyboard.press('Control+Shift+Equal');
    assert.deepEqual(await sizes(), increased, 'Ctrl++ also increases by one pixel');
    await page.keyboard.press('Control+Minus');
    assert.deepEqual(await sizes(), initial);
    console.log(edition, 'font shortcuts adjust explicit and inherited text by 1px and persist');
  } finally { await app.close(); }
}
