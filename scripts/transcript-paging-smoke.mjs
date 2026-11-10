import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { makeFixture } from './handbook-ui-fixture.mjs';

const out = await fs.mkdtemp(path.resolve('.test-data/transcript-pages-'));
const data = makeFixture('case-member-questions', 4, 1, { actor: 'Bob', screen: '工作会话', status: '就绪' }, 'answered');
const rows = (label, count) => Array.from({ length: count }, (_, i) => ({
  id: label + i, role: 'user', text: label + i, createdAt: data.at,
}));
const parent = data.snapshot.sessions[0];
parent.messages = rows('主会话-', 345);
data.snapshot.selectedProjectId = data.project.id;
data.snapshot.sessions.push({ ...parent, id: 'child', title: '滚动子会话', parentId: parent.id, messages: rows('子会话-', 185),
  fork: { parentId: parent.id, capturedAt: data.at, parentMessageCount: 340, visibleSnapshotPath: 'snapshot', inheritedSourceIds: [] } });
data.snapshot.sideChats = [{ id: 'side', parentId: parent.id, parentTitle: parent.title, capturedAt: data.at, projectId: data.project.id,
  session: { ...parent, id: 'side-thread', messages: [] }, draft: '', inheritedMessageCount: 340 }];
const modulePath = file => JSON.stringify(path.resolve(file).replaceAll('\\', '/'));
await fs.writeFile(path.join(out, 'entry.tsx'), `
  import { installFixture } from ${modulePath('scripts/handbook-ui-fixture.mjs')};
  const data = ${JSON.stringify(data)}; installFixture(data);
  const original = window.workbench.call; window.pageReads = [];
  window.workbench.call = async (action,p) => {
    if (action.endsWith('.historyPage')) {
      window.pageReads.push([action,p.before,p.limit]);
      await new Promise(resolve => setTimeout(resolve, 60));
      const before = Math.max(0,p.before-p.limit);
      return { before, messages: data.snapshot.sessions[0].messages.slice(before,p.before) };
    }
    return original(action,p);
  };
  await import(${modulePath('src/renderer/main.tsx')});
`);
await build({ entryPoints: [path.join(out,'entry.tsx')], outdir: out, entryNames: 'renderer', bundle: true, splitting: true,
  platform: 'browser', format: 'esm', loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } });
await fs.copyFile('src/renderer/index.html', path.join(out,'index.html'));
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--allow-file-access-from-files'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(out,'index.html')).href);
  await page.locator('[data-session-id="' + parent.id + '"]').click();
  const main = page.locator('.messages[data-transcript-scroll]');
  const count = (el, n) => expect(el.locator('article.conversation-message.user')).toHaveCount(n);
  async function up(el, anchor, size) {
    await el.evaluate(node => { node.scrollTop = 0; });
    await expect.poll(() => el.evaluate(node => node.scrollTop)).toBe(0);
    const anchorEl = anchor && el.getByText(anchor, { exact:true });
    const y = anchorEl && (await anchorEl.boundingBox()).y;
    await el.hover(); await page.mouse.wheel(0,-64); await count(el,size);
    if (anchorEl) await expect.poll(async () => Math.abs((await anchorEl.boundingBox()).y - y)).toBeLessThan(4);
  }
  await count(main,160);
  await up(main,'主会话-185',320);
  await up(main,'主会话-25',345);
  if (!await page.locator('[data-session-id="child"]').isVisible()) await page.getByRole('button',{name:'展开会话菜单：'+parent.title,exact:true}).click();
  await page.locator('[data-session-id="child"]').click();
  const child = page.locator('#project-subsessions-panel .subsession-messages');
  await count(child,160);
  await up(child,'子会话-25',320);
  await expect(child.getByText('主会话-205',{exact:true})).toBeVisible();
  await up(child,'主会话-205',480);
  await up(child,'主会话-45',525);
  await page.getByRole('tab',{name:'侧边提问'}).click();
  const side = page.locator('#project-sidechats-panel .subsession-messages');
  await count(side,0);
  await up(side,null,160);
  await side.evaluate(el => {
    el.scrollTop = 0;
    const start = new Touch({ identifier: 1, target: el, clientY: 50 });
    const end = new Touch({ identifier: 1, target: el, clientY: 84 });
    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [start] }));
    el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [end] }));
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -60 }));
  });
  await count(side,320);
  await side.evaluate(el => { el.scrollTop=0; el.focus(); }); await page.keyboard.press('PageUp'); await count(side,340);
  await expect(side.getByText('主会话-340',{exact:true})).toHaveCount(0);
  expect(await page.evaluate(() => window.pageReads)).toEqual([
    ['subsession.historyPage',340,135],['subsession.historyPage',205,160],['subsession.historyPage',45,160],
    ['sidechat.historyPage',340,160],['sidechat.historyPage',180,160],['sidechat.historyPage',20,160],
  ]);
  expect(errors).toEqual([]);
  console.log('Main, child and side chat automatically page at the top and retain the reading position.');
} finally { await browser.close(); }
