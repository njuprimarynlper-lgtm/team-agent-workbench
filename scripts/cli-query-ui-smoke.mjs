import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const root = process.cwd(), out = path.join(root, 'artifacts', 'cli-query-ui-validation'); await fs.mkdir(out, { recursive: true });
await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
  import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
  import {ComposerCapabilities} from './src/renderer/composer-capabilities'; import {ComposerSettings} from './src/renderer/composer-settings'; import {ModelPicker} from './src/renderer/model-picker'; import './src/renderer/styles.css';
  function App(){const [selected,change]=useState([]),[revision,update]=useState(0);window.refresh=()=>update(value=>value+1);const s=window.session;
    return <div style={{padding:70,height:'100vh',overflow:'auto'}}><p>当前回复继续进行</p><div className="composer-controls" style={{position:'absolute',bottom:50,left:70}}><ComposerSettings session={s}/><ComposerCapabilities session={s} selected={selected} change={change}/></div><p aria-label="已选能力">{selected.map(item=>item.name).join(',')}</p><ModelPicker provider="codex" cwd={s.cwd} ready model="" changed={()=>{}}/></div>;
  }createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, format: 'iife', platform: 'browser', outfile: path.join(out, 'ui.js'), logLevel: 'silent' });
await fs.writeFile(path.join(out, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
const browser = await chromium.launch({ channel: 'msedge', headless: true }), page = await browser.newPage({ viewport: { width: 1160, height: 900 } });
const errors = [], checks = []; page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  window.session = { id: 's', provider: 'codex', cwd: 'C:\\workspace', status: 'running', model: '', messages: [], permissionMode: 'full' };
  window.calls = []; window.pluginResponses = []; window.modelResponses = [];
  const model = { models: [{ id: 'model-1', name: 'Model 1' }], quota: { windows: [], detail: '暂无额度', url: 'https://example.invalid/' }, checkedAt: '2026-10-08T00:00:00Z' };
  const option = (name, kind) => ({ id: kind + ':' + name, kind, name, invocation: name, enabled: true });
  window.workbench = { call: async (action, payload) => {
    window.calls.push({ action, payload });
    if (action === 'provider.catalog') return payload.forceRefresh ? new Promise(resolve => window.modelResponses.push(() => resolve(structuredClone(model)))) : structuredClone(model);
    if (action === 'session.model') { window.session.model = payload.model; window.refresh(); return window.session; }
    if (action === 'session.capabilities') {
      const result = { provider: 'codex', skills: [], plugins: [], checkedAt: 'now' };
      if (payload.kind === 'skill') return { ...result, skills: [option(window.session.cwd.includes('other') ? 'Other skill' : 'Fast skill', 'skill')] };
      if (window.session.cwd.includes('other')) return { ...result, plugins: [option('Other plugin', 'plugin')] };
      return new Promise(resolve => window.pluginResponses.push(() => resolve({ ...result, plugins: [option('Old plugin', 'plugin')] })));
    }
    throw Error('Unexpected action: ' + action);
  } };
});
try {
  await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
  await page.getByLabel('选择 Skill 和插件').click();
  const dialog = page.getByRole('dialog', { name: 'Skill 与插件', exact: true });
  await expect(dialog.getByRole('group', { name: '可用 Skills' }).getByRole('button', { name: 'Fast skill' })).toBeEnabled();
  await expect(dialog.getByRole('status')).toContainText('读取已安装插件中');
  await dialog.getByRole('button', { name: 'Fast skill' }).click();
  await expect(page.getByLabel('已选能力')).toHaveText('Fast skill');
  await page.screenshot({ path: path.join(out, 'skills-ready-plugins-pending.png') });
  checks.push('插件未返回时 Skill 已显示、可选择；只在插件区显示等待');
  await dialog.getByRole('button', { name: '关闭选项', exact: true }).click();
  await page.evaluate(() => { window.session.cwd = 'C:\\other'; window.refresh(); });
  await page.getByLabel('选择 Skill 和插件').click();
  await expect(dialog.getByRole('button', { name: 'Other skill' })).toBeVisible();
  await page.evaluate(() => window.pluginResponses.forEach(resolve => resolve()));
  await expect(dialog.getByRole('button', { name: 'Other plugin' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Old plugin' })).toHaveCount(0);
  checks.push('切换目录后忽略旧查询的迟到结果');
  await dialog.getByRole('button', { name: '关闭选项', exact: true }).click();
  await page.getByLabel('选择模型').click();
  const models = page.getByRole('dialog', { name: '模型与额度', exact: true });
  await expect(models.getByRole('button', { name: 'Model 1' })).toBeEnabled();
  await models.getByRole('button', { name: '刷新选项', exact: true }).click();
  await expect(models.getByRole('status')).toBeVisible();
  await expect(models.getByRole('button', { name: 'Model 1' })).toBeEnabled();
  await models.getByRole('button', { name: 'Model 1' }).click();
  await expect(models).toHaveCount(0); await expect(page.getByText('当前回复继续进行')).toBeVisible();
  expect(await page.evaluate(() => window.session.status)).toBe('running');
  await page.evaluate(() => window.modelResponses.forEach(resolve => resolve()));
  const calls = await page.evaluate(() => window.calls);
  expect(calls.some(call => call.action === 'provider.catalog' && call.payload.forceRefresh === true)).toBe(true);
  expect(calls.filter(call => call.action === 'session.capabilities').every(call => ['skill', 'plugin'].includes(call.payload.kind))).toBe(true);
  checks.push('模型后台刷新时已有选项可用；切换不停止当前回复；手动刷新明确绕过缓存');
  await page.getByRole('button', { name: '刷新模型与额度' }).click();
  await expect(page.getByLabel('会话模型')).toBeEnabled();
  await page.evaluate(() => window.modelResponses.forEach(resolve => resolve()));
  checks.push('创建会话的模型选择同样保留可用选项');
  if (errors.length) throw Error(errors.join('\n'));
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify({ checks, errors }, null, 2)); console.log(checks.join('\n'));
} finally { await browser.close(); }
