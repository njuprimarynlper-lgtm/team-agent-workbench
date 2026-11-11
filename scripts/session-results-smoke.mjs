import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const root = process.cwd(), out = path.join(root, 'artifacts', 'session-results');
await fs.mkdir(out, { recursive: true });
await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ComposerCapabilities} from './src/renderer/composer-capabilities';
import {SessionMaterials} from './src/renderer/session-materials';
import {SessionSyncFrame} from './src/renderer/session-sync-frame';
import './src/renderer/styles.css';
function App(){const[s,set]=useState(window.session);window.patchSession=patch=>{Object.assign(window.session,patch);set({...window.session});};
return <main style={{padding:'250px 30px 30px'}}><h1>成果关联验收</h1><SessionSyncFrame session={s} api={window.workbench} changed={async()=>{}} references={{sourceIds:[],select:()=>{},detach:async source=>{window.session.sources=window.session.sources.filter(item=>item.id!==source.id);window.patchSession({sources:window.session.sources});}}}><div className="composer"><textarea aria-label="任务输入" defaultValue="继续检查项目边界"/><div className="composer-bottom"><ComposerCapabilities session={s} selected={[]} change={()=>{}} changed={async()=>window.patchSession({sources:window.session.sources})}/></div></div></SessionSyncFrame></main>;}
createRoot(document.getElementById('root')).render(<App/>);` }, bundle: true, format: 'iife', platform: 'browser', outfile: path.join(out, 'ui.js'), logLevel: 'silent' });
await fs.writeFile(path.join(out, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
const browser = await chromium.launch({ channel: 'msedge', headless: true }), page = await browser.newPage({ viewport: { width: 1360, height: 960 } }), errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'), projectId = 'project-a';
  const candidate = (scope, n, title, category, folderId, count = 1, version = 1) => ({ reference: { scope, projectId, id: id(n), version }, title, category, folderId, content: '# 验证资料\n\n' + title + '的原始正文。\n\n- 验证结果\n- 边界说明', author: scope === 'personal' ? '个人成果' : 'bob', updatedAt: '2026-11-10T00:00:00Z', attachments: Array.from({ length: count }, (_, i) => ({ name: title + '-' + i + '.csv', size: 1024, sha256: String(n).repeat(64) })) });
  window.session = { id: id(99), provider: 'codex', purpose: 'work', title: '项目边界检查', status: 'running', binding: { project: { id: projectId, name: '团队工作台', remoteRoot: '/p' } }, sources: [], messages: [], approvals: [] };
  window.data = {
    personal: { items: [candidate('personal', 1, '权限边界', 'exploration', id(51)), candidate('personal', 2, '分页校验', 'capability', undefined, 2), candidate('personal', 3, '缓存策略', 'exploration', undefined, 0, 2)], directories: [{ id: id(51), parentId: 'exploration', name: '离线验证', revision: 1 }], available: true, cached: false },
    team: { items: [candidate('team', 1, '权限边界', 'exploration', id(52)), candidate('team', 4, '部署指引', 'capability', undefined, 0)], directories: [{ id: id(52), parentId: 'exploration', name: '工具规范', revision: 1 }], available: true, cached: true },
  };
  window.session.sources.push({ id: id(63), name: '缓存策略 · v1', sourcePath: 'local-conclusion:' + id(3) + ':v1', sha256: 'old', localPath: '/frozen.md', resultLink: { reference: { ...window.data.personal.items[2].reference, version: 1 }, attachments: [] } });
  window.calls = []; window.refreshMode = 'hold'; window.partial = true; window.noCache = false;
  window.workbench = { subscribe: () => () => {}, call: async (action, payload) => {
    window.calls.push({ action, payload: structuredClone(payload) });
    if (action === 'session.resultCandidates') {
      if (payload.scope === 'team' && payload.refresh) {
        if (window.refreshMode === 'hold') await new Promise((resolve, reject) => { window.releaseRefresh = ok => ok ? resolve() : reject(Error('网络暂时不可用，保留缓存')); });
      } else if (payload.scope === 'team' && window.noCache) return { items: [], directories: [], available: false, cached: false };
      const value = structuredClone(window.data[payload.scope]);
      for (const item of value.items) { const source = [...window.session.sources].reverse().find(s => !s.supersededBy && s.resultLink?.reference.scope === item.reference.scope && s.resultLink.reference.id === item.reference.id); item.linkedVersion = source?.resultLink.reference.version; }
      return value;
    }
    if (action === 'session.attachResults') {
      const added = [], failed = [];
      for (const reference of payload.references) {
        if (reference.scope === 'team' && window.partial) { failed.push({ reference, error: '此版本附件权限已失效' }); continue; }
        const item = window.data[reference.scope].items.find(item => item.reference.id === reference.id), source = { id: id(100 + window.session.sources.length), sourcePath: reference.scope === 'personal' ? 'local-conclusion:' + reference.id + ':v' + reference.version : '/p/submissions/bob/result.md', localPath: '/snapshot.md', name: item.title + ' · v' + reference.version, sha256: id(window.session.sources.length), resultLink: { reference, attachments: [] } };
        for (const prior of window.session.sources) if (prior.resultLink.reference.id === reference.id && prior.resultLink.reference.scope === reference.scope) prior.supersededBy = source.id;
        window.session.sources.push(source); added.push({ reference, source });
      }
      return { added, failed };
    }
    if (action === 'session.source.preview') return { type: 'text', content: '# 已关联正文', name: 'snapshot.md' };
    if (action === 'session.capabilities') return { provider: 'codex', skills: [], plugins: [], checkedAt: '' };
    throw Error('Unexpected API ' + action);
  } };
});
const dialog = page.getByRole('dialog', { name: '关联成果', exact: true });
const open = async () => { await page.getByRole('button', { name: '添加内容或工具', exact: true }).click(); await page.getByRole('menuitem', { name: '项目成果', exact: true }).click(); await expect(dialog).toBeVisible(); };
const choose = title => dialog.getByRole('checkbox', { name: '关联成果：' + title, exact: true });
try {
  await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
  await open();
  await expect(dialog.getByRole('button', { name: '离线验证', exact: true })).toBeVisible();
  await choose('权限边界').check();
  await dialog.getByRole('button', { name: '已有能力', exact: true }).click(); await choose('分页校验').check();
  await dialog.getByRole('button', { name: '预览', exact: true }).click(); await expect(dialog.getByRole('complementary', { name: '成果预览', exact: true })).toContainText('分页校验的原始正文');
  await expect(dialog.getByLabel('已选成果')).toContainText('个人 · 权限边界 · v1');
  await dialog.getByRole('tab', { name: '团队成果' }).click();
  await expect(dialog).toContainText('正在更新列表，可以继续选择已有成果');
  await expect(choose('权限边界')).toBeEnabled(); await choose('权限边界').check();
  await expect(dialog.getByRole('button', { name: '离线验证', exact: true })).toHaveCount(0); await expect(dialog.getByRole('button', { name: '工具规范', exact: true })).toBeVisible();
  await page.evaluate(() => { window.refreshMode = 'success'; window.releaseRefresh(false); });
  await expect(dialog).toContainText('网络暂时不可用，保留缓存'); await expect(choose('权限边界')).toBeChecked();
  await expect(dialog).toContainText('已选 3 项，附带 4 个附件入口');
  await dialog.getByRole('tab', { name: '个人成果' }).click(); await expect(choose('分页校验')).toBeChecked();
  await dialog.getByRole('searchbox').fill('权限'); await expect(choose('权限边界')).toBeChecked();
  await page.screenshot({ path: path.join(out, 'mixed-selection.png') });
  await dialog.getByRole('button', { name: '关联 3 项成果', exact: true }).click();
  await expect(dialog).toContainText('已关联 2 项，其余未完成'); await expect(dialog).toContainText('此版本附件权限已失效');
  await expect(dialog.getByRole('button', { name: '关联 1 项成果', exact: true })).toBeEnabled();
  await page.evaluate(() => { window.partial = false; }); await dialog.getByRole('button', { name: '关联 1 项成果', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.calls.filter(call => call.action === 'session.attachResults').map(call => call.payload.references.length))).toEqual([3, 1]);
  expect(await page.evaluate(() => window.calls.some(call => /send|download/.test(call.action)))).toBe(false);
  await expect(page.getByLabel('任务输入')).toHaveValue('继续检查项目边界');
  await open(); await expect(choose('权限边界')).toBeDisabled();
  await dialog.getByRole('button', { name: '更新引用', exact: true }).click(); await expect(dialog.getByLabel('已选成果')).toContainText('缓存策略 · v2');
  await dialog.getByRole('button', { name: '关联 1 项成果', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await open(); await expect(choose('缓存策略')).toBeDisabled(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await open(); await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } }); await expect(dialog).toHaveCount(0);
  await page.evaluate(() => { window.patchSession({ provider: 'cursor', sources: [] }); window.noCache = true; window.refreshMode = 'hold'; });
  await open(); await dialog.getByRole('tab', { name: '团队成果' }).click(); await expect(dialog).toContainText('正在读取成果'); await expect(dialog.getByRole('button', { name: '全部目录' })).toBeDisabled();
  await page.evaluate(() => { window.noCache = false; window.refreshMode = 'success'; window.releaseRefresh(true); });
  await expect(choose('权限边界')).toBeEnabled(); await choose('权限边界').check();
  await dialog.getByRole('button', { name: '预览', exact: true }).first().click(); await page.screenshot({ path: path.join(out, 'team-preview.png') });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.patchSession({ provider: 'claude' }));
  for (let i = 0; i < 2; i++) { await open(); await choose('权限边界').check(); await expect(dialog.getByRole('button', { name: '关联 1 项成果', exact: true })).toBeEnabled(); await dialog.getByRole('button', { name: '关联 1 项成果', exact: true }).click(); await expect(dialog).toHaveCount(0); await page.evaluate(() => window.patchSession({ sources: [] })); }
  await page.evaluate(() => window.patchSession({ provider: 'codex', codexRemote: {} }));
  await page.getByRole('button', { name: '添加内容或工具', exact: true }).click(); await expect(page.getByRole('menuitem', { name: '项目成果', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks: ['cross-folder/tab multi-select and equal-title scope isolation', 'cache stays selectable during refresh and transient failure', 'search, preview and version update', 'partial success retry submits failures only', 'running association preserves draft without sending', 'Escape/outside close and reopen', 'Cursor CLI and Claude entry', 'remote mode excluded'], out }));
} catch (error) { console.error(JSON.stringify({ pageErrors: errors })); await page.screenshot({ path: path.join(out, 'failure.png') }); throw error; }
finally { await browser.close(); }
