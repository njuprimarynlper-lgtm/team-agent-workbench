// Offline component regression: no CLI, account service or personal settings.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

const out = path.resolve('.test-data/agent-settings-' + Date.now());
await fs.mkdir(out, { recursive: true });
await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{AgentSettings}from'./src/renderer/agent-settings';import'./src/renderer/styles.css';
function App(){const[settings,setSettings]=useState(window.saved);window.updateSettings=setSettings;
return <section className="modal" style={{margin:'20px auto',maxHeight:'95vh'}}><AgentSettings settings={settings} providers={[]} auth={{codex:{status:'unknown'},cursor:{status:'unknown'},claude:{status:'unknown'}}} toolSessions={[]} openTools={()=>{}} api={window.workbench}/></section>}
createRoot(document.getElementById('root')).render(<App/>);` }, bundle: true, outfile: path.join(out, 'ui.js'), logLevel: 'silent' });
await fs.writeFile(path.join(out, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="ui.css"><div id="root"></div><script src="ui.js"></script>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.context().setOffline(true);
  await page.addInitScript(() => {
    window.saved = { codexRequestGuard: true, providerPaths: { codex: '', cursor: '', claude: '' }, connections: [], lastWorkspace: '', localWorkspace: 'fixture' };
    window.calls = []; window.failSave = false; window.holdAuth = false;
    window.workbench = { call: async (action, payload) => {
      window.calls.push({ action, payload });
      if (action === 'settings.agent.save') {
        if (window.failSave) throw Error('fixture disk error');
        window.saved = { ...window.saved, ...payload, providerPaths: { ...window.saved.providerPaths, ...payload.providerPaths } };
        window.updateSettings(window.saved); return true;
      }
      if (action === 'provider.auth') { if (window.holdAuth) await new Promise(resolve => { window.releaseAuth = resolve; }); return {}; }
      if (action === 'providers.detect') return [];
      throw Error('Unexpected action: ' + action);
    } };
  });
  await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
  const toggle = page.getByRole('switch', { name: 'Codex / Cursor 请求大小保护（1 MB）', exact: true });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  // The old account panel's automatic check ran after 300 ms.
  await page.waitForTimeout(400); assert.deepEqual(await page.evaluate(() => window.calls), []);
  await page.getByLabel('Codex CLI 程序路径', { exact: true }).fill('unsaved-codex');
  await toggle.click(); await expect(page.getByRole('status')).toContainText('请求大小保护已关闭');
  assert.deepEqual(await page.evaluate(() => window.calls), [{ action: 'settings.agent.save', payload: { codexRequestGuard: false } }]);
  assert.equal(await page.evaluate(() => window.saved.providerPaths.codex), '');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText('设置已保存。', { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => window.saved.codexRequestGuard), false);
  assert(await page.evaluate(() => window.calls.every(call => call.action === 'settings.agent.save')));
  await page.evaluate(() => { window.failSave = true; });
  await toggle.click(); await expect(page.getByRole('alert')).toContainText('开关未保存');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.evaluate(() => { window.failSave = false; window.holdAuth = true; });
  await page.getByRole('region', { name: 'Codex 登录状态', exact: true }).getByRole('button', { name: '重新检测', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Codex 登录状态', exact: true }).getByRole('button', { name: '重新检测', exact: true })).toBeDisabled();
  await toggle.click(); await expect(page.getByText('已保存：请求大小保护已开启。', { exact: true })).toBeVisible();
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.action === 'provider.auth').map(call => call.payload.provider)), ['codex']);
  await page.evaluate(() => window.releaseAuth());
  await page.getByRole('button', { name: '检测 CLI', exact: true }).click();
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.action === 'providers.detect').length), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: no automatic detection, independent guard save, unsaved paths preserved, save-only footer, failed save rollback, and toggling during a pending account check.');
} finally { await browser.close(); }
