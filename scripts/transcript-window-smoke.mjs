import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron, expect } from '@playwright/test';

const require = createRequire(import.meta.url), output = path.resolve('.test-data/transcript-window-' + Date.now());
await fs.mkdir(output, { recursive: true });
await build({ entryPoints: ['tests/fixtures/transcript-window-ui.tsx'], outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', logLevel: 'silent' });
await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="transcript-window-ui.js"></script>');
await fs.writeFile(path.join(output, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(output, 'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:800,height:700,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});win.loadFile(${JSON.stringify(path.join(output, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ executablePath: require('electron'), args: [path.join(output, 'main.cjs')], env, timeout: 20000 });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const scroll = page.locator('[data-transcript-scroll]'), rows = scroll.locator('[data-transcript-anchor]');
  await expect(rows).toHaveCount(160);
  assert.equal(await rows.first().getAttribute('data-transcript-anchor'), 'fixture:m740');
  for (let turn = 0; turn < 4; turn++) {
    const anchor = turn === 0 ? await rows.first().evaluate(element => ({ id: element.getAttribute('data-transcript-anchor'), top: element.getBoundingClientRect().top })) : undefined;
    await scroll.evaluate((element, turn) => { if (turn === 0) element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 })); else element.scrollTop = 0; }, turn);
    await expect.poll(async () => rows.first().getAttribute('data-transcript-anchor')).toBe(`fixture:m${580 - turn * 160}`);
    if (anchor) {
      const retainedTop = await scroll.locator(`[data-transcript-anchor="${anchor.id}"]`).evaluate(element => element.getBoundingClientRect().top);
      assert(Math.abs(retainedTop - anchor.top) < 3, 'paging must preserve the reading position');
    }
    assert((await rows.count()) <= 480, 'old rows must be removed from the DOM');
    if (turn === 1) {
      await page.locator('#append').click();
      await expect.poll(async () => rows.first().getAttribute('data-transcript-anchor')).toBe('fixture:m420');
      assert((await rows.count()) <= 480, 'streaming while reading history must retain a bounded window');
    }
  }
  assert.equal(await rows.first().getAttribute('data-transcript-anchor'), 'fixture:m100');
  for (let turn = 0; turn < 2; turn++) {
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new WheelEvent('wheel', { deltaY: 400 })); });
    await expect.poll(async () => rows.first().getAttribute('data-transcript-anchor')).toBe(`fixture:m${260 + turn * 160}`);
    assert((await rows.count()) <= 480, 'downward paging must evict the oldest rows');
  }
  await page.locator('#latest').click();
  await expect(rows).toHaveCount(160);
  assert.equal(await rows.first().getAttribute('data-transcript-anchor'), 'fixture:m741');
  assert.deepEqual(errors, []);
  console.log('Transcript paging, eviction, append and return-to-latest passed');
} finally { await app?.close(); }
