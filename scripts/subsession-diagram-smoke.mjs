import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron, expect } from '@playwright/test';

const require = createRequire(import.meta.url), output = path.resolve('.test-data/subsession-diagram');
await fs.mkdir(output, { recursive: true });
await build({ entryPoints: ['tests/fixtures/subsession-diagram-ui.tsx'], outdir: output, entryNames: 'renderer', chunkNames: 'chunk-[hash]', bundle: true, splitting: true, minify: true, platform: 'browser', format: 'esm', target: 'chrome130', loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, logLevel: 'silent' });
await fs.copyFile('src/renderer/index.html', path.join(output, 'index.html'));
await fs.writeFile(path.join(output, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setName('Subsession diagram fixture');app.setPath('userData',${JSON.stringify(path.join(output, 'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1000,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});win.loadFile(${JSON.stringify(path.join(output, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({ executablePath: require('electron'), args: [path.join(output, 'main.cjs')], env, timeout: 20000 });
  const page = await app.firstWindow(), errors = [], requests = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  const image = page.locator('.mermaid-diagram-image'), outer = page.locator('.subsession-messages'), inner = page.locator('.mermaid-diagram-viewport');
  await expect(image).toHaveCount(1, { timeout: 20000 }); await page.waitForFunction(() => { const image = document.querySelector('.mermaid-diagram-image'); return image?.complete && image.naturalHeight > 0; });
  const metrics = () => page.evaluate(() => {
    const outer = document.querySelector('.subsession-messages'), inner = document.querySelector('.mermaid-diagram-viewport'), diagram = document.querySelector('.mermaid-diagram'), image = document.querySelector('.mermaid-diagram-image');
    const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    return { outer: rect(outer), inner: rect(inner), diagram: rect(diagram), image: rect(image), vertical: inner.scrollHeight - inner.clientHeight, horizontal: inner.scrollWidth - inner.clientWidth, outerOverflow: outer.scrollHeight - outer.clientHeight, innerTop: inner.scrollTop, outerTop: outer.scrollTop };
  });
  const align = () => page.evaluate(() => { const outer = document.querySelector('.subsession-messages'), diagram = document.querySelector('.mermaid-diagram'); outer.scrollTop += diagram.getBoundingClientRect().top - outer.getBoundingClientRect().top - 10; });
  const cases = [];
  for (const width of [310, 350]) {
    await page.locator('#diagram-panel').evaluate((element, width) => { element.style.width = width + 'px'; }, width);
    await align(); await page.getByRole('button', { name: '适应宽度', exact: true }).click();
    for (const zoom of [1, .5, 2, 3]) {
      await align(); await page.getByRole('button', { name: '适应宽度', exact: true }).click();
      for (let step = 0; step < Math.abs(zoom - 1) * 4; step++) await page.getByRole('button', { name: zoom < 1 ? '缩小' : '放大', exact: true }).click();
      await page.waitForTimeout(100); await align(); await page.waitForTimeout(100);
      const before = await metrics();
      assert(before.vertical <= 1, `Only the message list should scroll vertically: width=${width}, zoom=${zoom}, inner overflow=${before.vertical}`);
      assert(before.outerOverflow > 0);
      await outer.evaluate(element => { element.scrollTop += 150; });
      await page.waitForTimeout(100);
      const moved = await metrics(), delta = moved.outerTop - before.outerTop;
      assert(delta > 100); assert(Math.abs((before.diagram.top - moved.diagram.top) - delta) < 2); assert(Math.abs((before.image.top - moved.image.top) - delta) < 2);
      if (zoom > 1) {
        assert(moved.horizontal > 0); await inner.evaluate(element => { element.scrollLeft = 100; });
        await page.waitForTimeout(100);
        const horizontal = await metrics(); assert(horizontal.image.left < moved.image.left); assert(Math.abs(horizontal.diagram.left - moved.diagram.left) < 1); assert(Math.abs(horizontal.image.top - moved.image.top) < 1);
      }
      // Pixel-level clipping check in the same Electron build as the product.
      const clip = await metrics();
      const capture = await app.evaluate(async ({ BrowserWindow }, clip) => {
        const win = BrowserWindow.getAllWindows()[0];
        const picture = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        const viewport = await win.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
        const normalized = picture.resize(viewport), size = normalized.getSize(), bitmap = normalized.toBitmap(); let found = 0, outside = 0;
        const left = Math.max(clip.outer.left, clip.inner.left), right = Math.min(clip.outer.right, clip.inner.right), top = Math.max(clip.outer.top, clip.inner.top), bottom = Math.min(clip.outer.bottom, clip.inner.bottom);
        for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) { const i = (y * size.width + x) * 4; if (bitmap[i + 2] > 235 && bitmap[i + 1] < 25 && bitmap[i] >= 35 && bitmap[i] <= 70) { found++; if (x < left - 2 || x > right + 2 || y < top - 2 || y > bottom + 2) outside++; } }
        return { found, outside, png: normalized.toPNG().toString('base64') };
      }, clip);
      await fs.writeFile(path.join(output, `width-${width}-zoom-${zoom}.png`), Buffer.from(capture.png, 'base64'));
      const pixels = { found: capture.found, outside: capture.outside };
      assert(pixels.found > 20, 'The screenshot must include rendered chart nodes'); assert.equal(pixels.outside, 0, 'Chart pixels must remain within the diagram/message viewport: ' + JSON.stringify(clip));
      cases.push({ width, zoom, ...pixels });
    }
  }
  await outer.evaluate(element => { element.scrollTop = 0; }); await page.waitForTimeout(100);
  const track = (await metrics()).outer;
  await page.mouse.move(track.right - 6, track.top + 28); await page.mouse.down(); await page.mouse.move(track.right - 6, track.top + 128, { steps: 12 }); await page.mouse.up();
  await expect.poll(async () => (await metrics()).outerTop).toBeGreaterThan(50);
  await align(); await outer.hover(); const beforeWheel = await metrics(); await page.mouse.wheel(0, 180); await expect.poll(async () => (await metrics()).outerTop).toBeGreaterThan(beforeWheel.outerTop + 50);
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  const report = { passed: true, electron: require('electron/package.json').version, rendering: 'isolated offscreen window', scrollbarDrag: true, wheel: true, cases, externalRequests: requests.length };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  const page = app && await app.firstWindow();
  if (page) { console.error(await page.locator('.mermaid-diagram').evaluateAll(elements => elements.map(el => ({ html: el.outerHTML.slice(0, 800), height: el.getBoundingClientRect().height })))); }
  throw error;
} finally { await app?.close().catch(() => {}); }
