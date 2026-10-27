// Isolated renderer with deferred fake reads; no account data or network requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
const output=await fs.mkdtemp(path.join(os.tmpdir(),'team-cache-ui-'));
await build({entryPoints:['tests/fixtures/team-cache-ui.tsx'],outdir:output,bundle:true,platform:'browser',format:'iife',target:'chrome130',loader:{'.woff':'file','.woff2':'file','.ttf':'file'},logLevel:'silent'});
await fs.writeFile(path.join(output,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="team-cache-ui.css"><div id="root"></div><script src="team-cache-ui.js"></script>');
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1280,height:960}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));await page.context().setOffline(true);await page.goto(pathToFileURL(path.join(output,'index.html')).href);
  const search=page.getByRole('textbox',{name:'搜索团队成果'}),card=page.locator('[data-result-id]');
  await expect(card).toHaveCount(1);await expect(search).toBeEnabled();await search.fill('缓存');
  await card.locator('.result-card-toggle').click();await expect(card.getByRole('region')).toContainText('缓存正文可以立即阅读');
  await expect(card.getByRole('button',{name:/存入个人成果库/})).toBeEnabled();
  await page.getByRole('button',{name:'打开成员窗口'}).click();const dialog=page.getByRole('dialog',{name:'成员与权限',exact:true});
  await expect(dialog).toContainText('缓存成员');await expect(dialog.getByRole('button',{name:'关闭项目窗口'})).toBeEnabled();await dialog.getByRole('button',{name:'关闭项目窗口'}).click();await expect(dialog).toHaveCount(0);
  await page.evaluate(()=>window.teamFixture.finish('failure'));await expect(page.getByRole('alert')).toContainText('网络暂时不可用');await expect(card).toHaveCount(1);await expect(search).toBeEnabled();
  await page.getByRole('button',{name:'刷新',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.teamFixture.pending().length)).toBeGreaterThan(0);await page.evaluate(()=>window.teamFixture.finish('deleted'));await expect(card).toHaveCount(0);
  await page.getByRole('button',{name:'首次无缓存'}).click();await expect(search).toBeDisabled();await expect.poll(()=>page.evaluate(()=>window.teamFixture.pending().length)).toBeGreaterThan(0);await page.evaluate(()=>window.teamFixture.finish('success'));await expect(search).toBeEnabled();await expect(card).toHaveCount(1);
  await page.getByRole('button',{name:'刷新',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.teamFixture.pending().length)).toBeGreaterThan(0);await page.evaluate(()=>window.teamFixture.finish('revoked'));await expect(card).toHaveCount(0);await expect(page.getByRole('alert')).toContainText('没有此项目的访问权限');
  await page.getByRole('button',{name:'使用缓存'}).click();await expect(card).toHaveCount(1);await page.getByRole('button',{name:'打开成员窗口'}).click();await expect(dialog).toContainText('缓存成员');await expect.poll(()=>page.evaluate(()=>window.teamFixture.pending().includes('group.details'))).toBeTruthy();await page.evaluate(()=>window.teamFixture.finish('revoked'));await expect(dialog).not.toContainText('缓存成员');
  assert.deepEqual(errors,[]);await page.screenshot({path:path.join(output,'team-cache.png'),fullPage:true});console.log('Team cache UI checks passed: cached interactions, close during refresh, first load, failures, removals and revocation. '+output);
} finally {await browser.close();}
