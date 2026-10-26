// Isolated renderer checks for project association; no SSH or model calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const root = process.cwd(), out = await fs.mkdtemp(path.join(root, '.test-data', 'project-link-ui-'));
const modulePath = name => JSON.stringify(path.join(root, name).replaceAll('\\', '/'));
await fs.writeFile(path.join(out, 'entry.tsx'), `
import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {LocalProjectConnection, ProjectCentralConnection} from ${modulePath('src/renderer/project-connection')};
import ${modulePath('src/renderer/styles.css')};
const profile={id:'node',mode:'sftp',host:'node-a',port:22,username:'alice',projects:[]};
const group={groupName:'a',groupLabel:'算法组',canCreateProject:true};
window.fixture={calls:[],configured:0,linked:0,pending:undefined};
window.workbench={call:(action,payload)=>{window.fixture.calls.push({action,payload});return new Promise((resolve,reject)=>{window.fixture.pending=ok=>ok?resolve(true):reject(new Error('连接已断开'));});}};
function App(){const [state,set]=useState({profile:undefined,groups:[],remote:false});window.fixture.set=set;
return <div style={{padding:30,maxWidth:600}}>{state.remote?<ProjectCentralConnection profile={state.profile} connected={false} configure={()=>window.fixture.configured++}/>:<LocalProjectConnection projectId="project" profile={state.profile} groups={state.groups} configure={()=>window.fixture.configured++} linked={async()=>{window.fixture.linked++;}}/>}</div>;}
window.fixture.profile=profile;window.fixture.group=group;createRoot(document.getElementById('root')).render(<App/>);
`);
await build({ entryPoints: [path.join(out, 'entry.tsx')], outfile: path.join(out, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', loader: { '.woff2': 'file' }, logLevel: 'silent' });
await fs.writeFile(path.join(out, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="entry.css"><div id="root"></div><script src="entry.js"></script>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } }); await page.context().setOffline(true);
  const errors = []; page.on('pageerror', e => errors.push(e.message)); await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
  await page.getByRole('button', { name: '连接中央节点', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.configured), 1);
  await expect(page.getByRole('button', { name: '关联项目', exact: true })).toHaveCount(0);
  const set = async (count, extra = {}) => page.evaluate(({ count, extra }) => {
    const f = window.fixture; f.set({ profile: { ...f.profile, ...extra }, groups: Array.from({ length: count }, (_, i) => ({ ...f.group, groupName: 'group-' + i, groupLabel: '工作组 ' + i })), remote: false });
  }, { count, extra });
  await set(1); const link = page.getByRole('button', { name: '关联项目', exact: true });
  await expect(link).toBeEnabled(); await expect(page.getByRole('combobox')).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.fixture.calls.length), 0, 'selecting a sole group never links until confirmation');
  await link.click(); await expect(page.getByRole('button', { name: '正在关联…', exact: true })).toBeDisabled();
  await expect(page.getByLabel('更换中央节点')).toBeDisabled();
  assert.deepEqual(await page.evaluate(() => window.fixture.calls[0]), { action: 'project.link', payload: { projectId: 'project', groupName: 'group-0' } });
  await page.evaluate(() => window.fixture.pending(false)); await expect(page.getByRole('alert')).toContainText('连接已断开'); await expect(link).toBeEnabled();
  await link.click(); await page.evaluate(() => window.fixture.pending(true)); await expect(link).toBeEnabled();
  assert.equal(await page.evaluate(() => window.fixture.linked), 1);
  await set(2); await expect(link).toBeDisabled();
  await page.getByLabel('关联工作组').selectOption('group-1'); await expect(link).toBeEnabled();
  await set(2, { host: 'node-b' }); await expect(page.getByLabel('关联工作组')).toHaveValue(''); await expect(link).toBeDisabled();
  await page.getByLabel('关联工作组').selectOption('group-0');
  await set(1); await expect(link).toBeEnabled();
  await page.getByLabel('更换中央节点').click(); assert.equal(await page.evaluate(() => window.fixture.configured), 2);
  await set(0); await expect(link).toBeDisabled(); await expect(page.getByRole('status')).toContainText('没有可关联的工作组');
  await page.evaluate(() => { const f=window.fixture; f.set({ profile:f.profile,groups:[],remote:true }); });
  await expect(page.getByRole('combobox')).toHaveCount(0); await expect(link).toHaveCount(0);
  await page.getByRole('button', { name: '连接', exact: true }).click(); assert.equal(await page.evaluate(() => window.fixture.configured), 3);
  assert.equal(await page.evaluate(() => window.fixture.calls.length), 2, 'reconnect and change do not relink a project');
  assert.deepEqual(errors, []);
  console.log('Project association UI passed: no connection, single/multiple/no group, account switch, removed choice, failure/retry, pending lock, explicit confirmation, existing-project reconnect.');
} finally { await browser.close(); }
